"""Behavior at the model boundary, with only the paid HTTP transport replaced."""
import importlib.util
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from src.energy_exchange.collective_engine import build_world


def response(value):
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': json.dumps(value)}]}],
        'usage': {'input_tokens': 120, 'output_tokens': 50}}


def translation(updates=(), status='ready', questions=(), unhandled=()):
    return {'status': status, 'normalized_prompt': 'Keep 3 kWh in reserve.',
            'questions': list(questions), 'updates': list(updates),
            'unhandled': list(unhandled)}


def update(field='reserve_kwh', value=3, evidence='keep 3kwh at home', operation='set'):
    return dict(field=field, value=value, evidence=evidence, operation=operation)


class LLMTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('src.energy_exchange.collective_llm'),
                             'Server-side translation service must exist')
        from src.energy_exchange import collective_llm
        self.mod = collective_llm
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / 'llm.sqlite3'
        self.world = build_world({'population': 20})
        self.agent = next(a for a in self.world['agents'] if a['id'] == 'A17')
        self.calls = []

    def client(self, value, **kwargs):
        def transport(body, key):
            self.calls.append(body)
            if isinstance(value, Exception): raise value
            return response(value)
        return self.mod.LLMClient(api_key='test-private-key', db_path=self.db,
                                  transport=transport, **kwargs)

    def test_messy_explicit_request_becomes_valid_confirmable_change(self):
        client = self.client(translation([update()]))
        result = self.mod.translate_instruction('plz keep 3kwh at home dont sell it', self.agent, client=client)
        self.assertEqual(result['changes'], {'reserve_kwh': 3})
        self.assertEqual(result['errors'], [])
        self.assertTrue(result['requires_confirmation'])
        self.assertEqual(result['translation']['mode'], 'llm')
        self.assertEqual(self.calls[0]['text']['format']['type'], 'json_schema')
        self.assertTrue(self.calls[0]['text']['format']['strict'])
        self.assertFalse(self.calls[0]['store'])
        self.assertNotIn('test-private-key', json.dumps(result))

    def test_known_grammar_needs_no_paid_call(self):
        result = self.mod.translate_instruction('Keep 3 kWh in reserve', self.agent,
                                                client=self.client(RuntimeError('must not call')))
        self.assertEqual(result['changes'], {'reserve_kwh': 3})
        self.assertEqual(self.calls, [])

    def test_missing_party_quantity_asks_instead_of_applying_partial_changes(self):
        value = translation([update(value=5, evidence='birthday party')], questions=['How many kWh should stay at home?'])
        result = self.mod.translate_instruction('birthday party so keep more energy', self.agent, client=self.client(value))
        self.assertEqual(result['changes'], {})
        self.assertTrue(result['clarification_questions'])

    def test_invented_quantity_is_rejected_even_if_model_says_ready(self):
        value = translation([update(value=5, evidence='birthday party')])
        result = self.mod.translate_instruction('birthday party so keep more energy', self.agent, client=self.client(value))
        self.assertEqual(result['changes'], {})
        self.assertTrue(result['errors'] or result['clarification_questions'])

    def test_unhandled_weather_clause_blocks_entire_request(self):
        value = translation([update(field='max_offer_kwh', value=3, evidence='sell 3 kWh')],
                            unhandled=['unless it rains'])
        result = self.mod.translate_instruction('sell 3 kWh unless it rains', self.agent, client=self.client(value))
        self.assertEqual(result['changes'], {})
        self.assertTrue(result['errors'])

    def test_model_cannot_change_another_household_or_introduce_unknown_fields(self):
        value = translation([update(field='api_key', value='bad')])
        result = self.mod.translate_instruction('plz keep 3kwh at home', self.agent, client=self.client(value))
        self.assertEqual(result['changes'], {})

    def test_off_tick_price_and_unsupported_role_remain_invalid(self):
        for row in [update('min_price', 7.03, 'price 7.03'), update('budget', 30, 'budget 30')]:
            with self.subTest(row=row):
                result = self.mod.translate_instruction(row['evidence'], self.agent,
                                                       client=self.client(translation([row])))
                self.assertEqual(result['changes'], {})
                self.assertTrue(result['errors'])

    def test_explicit_relative_amount_is_applied_to_original_policy(self):
        result = self.mod.translate_instruction('keep 1 kWh more at home', self.agent,
            client=self.client(translation([update(value=1, evidence='keep 1 kWh more', operation='increase')])))
        self.assertEqual(result['changes'], {'reserve_kwh': 3})

    def test_api_failure_is_safe_and_does_not_apply_partial_change(self):
        client = self.client(RuntimeError('test-private-key secret traceback'))
        result = self.mod.translate_instruction('plz keep 3kwh at home', self.agent, client=client)
        self.assertEqual(result['changes'], {})
        self.assertEqual(result['translation']['status'], 'unavailable')
        self.assertNotIn('test-private-key', json.dumps(result))

    def test_repeated_translation_is_cached_and_uses_one_request(self):
        client = self.client(translation([update()]))
        first = self.mod.translate_instruction('plz keep 3kwh at home', self.agent, client=client)
        second = self.mod.translate_instruction('plz keep 3kwh at home', self.agent, client=client)
        self.assertEqual(first, second)
        self.assertEqual(len(self.calls), 1)

    def test_concurrent_repeated_translation_makes_one_paid_request(self):
        client = self.client(translation([update()]))
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.mod.translate_instruction('plz keep 3kwh at home', self.agent, client=client), range(4)))
        self.assertTrue(all(r['changes'] == {'reserve_kwh': 3} for r in results))
        self.assertEqual(len(self.calls), 1)

    def test_daily_limit_includes_failed_attempts_and_cached_calls_are_free(self):
        client = self.client(RuntimeError('failure'), daily_limit=1)
        self.mod.translate_instruction('keep more please 3kwh', self.agent, client=client)
        result = self.mod.translate_instruction('keep more please 4kwh', self.agent, client=client)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(result['changes'], {})
        self.assertEqual(result['translation']['status'], 'budget_limited')

    def test_incomplete_response_is_not_treated_as_valid_json(self):
        client = self.mod.LLMClient(api_key='fake', db_path=self.db,
            transport=lambda *_: {'status':'incomplete','output':[],'usage':{}})
        result = self.mod.translate_instruction('keep more please 3kwh', self.agent, client=client)
        self.assertEqual(result['changes'], {})
        self.assertTrue(result['errors'])

    def test_power_and_percentage_cannot_be_mistaken_for_energy(self):
        for phrase in ['keep 3 kW at home', 'keep 3 percent at home', 'keep 3 at home']:
            with self.subTest(phrase=phrase):
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([update(value=3, evidence=phrase)])))
                self.assertEqual(result['changes'], {})
                self.assertTrue(result['errors'])

    def test_delivery_time_must_be_grounded_in_the_original_request(self):
        phrase = 'plz sell between 2 PM and 4 PM'
        for i, values in enumerate([('2026-10-28T15:00:00+05:30', '2026-10-28T16:00:00+05:30'),
                                   ('2026-10-29T14:00:00+05:30', '2026-10-29T16:00:00+05:30')]):
            with self.subTest(values=values):
                self.db = self.db.with_name(f'time-{i}.sqlite3')
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([update('interval_start', values[0], phrase),
                                                    update('interval_end', values[1], phrase)])))
                self.assertEqual(result['changes'], {})
                self.assertTrue(result['errors'])

    def test_valid_price_strategy_is_executable_and_cached_for_the_world(self):
        from src.energy_exchange.collective_engine import run_experiment, verify_result
        rows = [{'id':a['id'], 'price_positions':[9000,6000,4000] if a['role']=='seller'
                 else [1000,5000,8000]} for a in self.world['agents']]
        client = self.client({'agents':rows})
        plan = self.mod.prepare_strategy_plan(self.world, client=client)
        self.assertEqual(plan['source'], 'llm')
        self.assertEqual(self.mod.prepare_strategy_plan(self.world, client=client), plan)
        self.assertEqual(len(self.calls), 1)
        result = run_experiment({'population':20,'negotiation_mode':'bargaining'},
                                world=self.world, strategy_plan=plan)
        self.assertEqual(verify_result(result), [])
        self.assertEqual(result['manifest']['strategy_plan'], plan)
        self.assertTrue(any(e['type']=='counteroffer_sent' for e in result['baseline']['events']))

    def test_invalid_strategy_falls_back_and_does_not_change_after_recovery(self):
        client = self.client({'agents':[]})
        first = self.mod.prepare_strategy_plan(self.world, client=client)
        self.assertEqual(first['source'], 'rules')
        self.assertEqual(first['provenance']['status'], 'invalid_output')
        second = self.mod.prepare_strategy_plan(self.world, client=self.client(RuntimeError('must not retry')))
        self.assertEqual(first, second)
        self.assertEqual(len(self.calls), 1)

    def test_model_cannot_drop_an_unsupported_condition(self):
        phrase = 'sell 3 kWh unless it rains'
        result = self.mod.translate_instruction(phrase, self.agent,
            client=self.client(translation([update('max_offer_kwh',3,'sell 3 kWh')])))
        self.assertEqual(result['changes'], {})
        self.assertTrue(result['errors'])

    def test_numbers_and_operations_need_the_right_meaning(self):
        cases = [
            ('My 8 guests arrive soon', update('min_price',8,'8 guests')),
            ('Please keep 1 kWh at home for me', update('reserve_kwh',1,'keep 1 kWh at home','increase')),
            ('I have 3 kWh in reserve already', update('max_offer_kwh',3,'3 kWh in reserve')),
            ('Raise my price to 8 rupees per kWh please', update('min_price',8,'Raise my price to 8 rupees per kWh','increase')),
            ('keep 1 kWh more at home', update('reserve_kwh',1,'keep 1 kWh more at home','set')),
        ]
        for phrase, row in cases:
            with self.subTest(phrase=phrase):
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([row])))
                self.assertEqual(result['changes'], {})

    def test_cached_strategy_stays_frozen_if_credential_becomes_unavailable(self):
        rows = [{'id':a['id'], 'price_positions':[9000,6000,4000] if a['role']=='seller'
                 else [1000,5000,8000]} for a in self.world['agents']]
        first = self.mod.prepare_strategy_plan(self.world, client=self.client({'agents':rows}))
        disabled = self.mod.LLMClient(api_key='', db_path=self.db)
        self.assertEqual(self.mod.prepare_strategy_plan(self.world, client=disabled), first)


if __name__ == '__main__': unittest.main()
