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

    def test_reported_unitless_price_has_a_confirmable_preview_without_a_paid_call(self):
        result = self.mod.translate_instruction('Make the minimum price 3.5', self.agent,
            client=self.client(RuntimeError('must not call')))
        self.assertEqual(result['changes'], {'min_price': 3.5})
        self.assertEqual(result['errors'], [])
        self.assertTrue(result['requires_confirmation'])
        self.assertIn('₹/kWh', ' '.join(result['assumptions']))
        self.assertEqual(self.calls, [])

    def test_llm_can_use_known_units_for_prices_and_budget(self):
        buyer = next(a for a in self.world['agents'] if a['role']=='buyer')
        cases = [
            ('could you make the minimum price 3.5 for me', self.agent, 'min_price', 3.5, 'set', 3.5),
            ('please put my selling price at 3.5 for me', self.agent, 'min_price', 3.5, 'set', 3.5),
            ('lower my minimum price by 0.5 please', self.agent, 'min_price', 0.5, 'decrease', 6.0),
            ('please make my maximum price eight for me', buyer, 'max_price', 8, 'set', 8),
            ('could you put my budget at 30 please', buyer, 'budget', 30, 'set', 30),
            ('In rupees per kWh, make the minimum price 3.5 please', self.agent, 'min_price', 3.5, 'set', 3.5),
            ('In INR/kWh, make the minimum price 3.5 please', self.agent, 'min_price', 3.5, 'set', 3.5),
        ]
        for phrase, agent, field, amount, operation, expected in cases:
            with self.subTest(phrase=phrase):
                result = self.mod.translate_instruction(phrase, agent,
                    client=self.client(translation([update(field, amount, phrase, operation)])))
                self.assertEqual(result['changes'], {field: expected})
                self.assertEqual(result['errors'], [])
                self.assertTrue(result['requires_confirmation'])
                self.assertIn('₹', ' '.join(result['assumptions']))

    def test_known_units_do_not_turn_other_numbers_or_currencies_into_prices(self):
        for phrase, field, amount in [
            ('make the minimum price 3.5 dollars please', 'min_price', 3.5),
            ('make the minimum price 3.5 kWh please', 'min_price', 3.5),
            ('make the minimum price 3.5 percent please', 'min_price', 3.5),
            ('my minimum price is fine and 8 guests are coming', 'min_price', 8),
            ('sell 3 kWh for 8 total please', 'min_price', 8),
            ('make the maximum price 3.5 please', 'min_price', 3.5),
        ]:
            with self.subTest(phrase=phrase):
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([update(field, amount, phrase)])))
                self.assertEqual(result['changes'], {})

    def test_short_evidence_cannot_hide_an_explicit_conflicting_unit(self):
        phrases = ['please make the minimum price 3.5 ' + suffix
                   for suffix in ['dollars', 'USD', 'kWh', 'percent', '%', 'guests']]
        phrases += ['In dollars, make the minimum price 3.5 please',
                    'Please make the minimum price 3.5, in dollars',
                    'Please make the minimum price 3.5, in kWh please',
                    'In kWh, make the minimum price 3.5 please',
                    'Make the minimum price 3.5 please, kWh',
                    'In paise, make the minimum price 3.5 please',
                    'In cents, make the minimum price 3.5 please',
                    'Using Mexican pesos, make the minimum price 3.5 please',
                    'In rupees per MWh, make the minimum price 3.5 please',
                    'In INR/kW, make the minimum price 3.5 please']
        for index, phrase in enumerate(phrases):
            with self.subTest(phrase=phrase):
                self.db = self.db.with_name(f'conflicting-unit-{index}.sqlite3')
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([update('min_price', 3.5, 'minimum price 3.5')])))
                self.assertEqual(result['changes'], {})
                self.assertEqual(result['translation']['status'], 'invalid_output')

    def test_price_and_time_assumptions_both_survive_translation(self):
        phrase = 'could you set my price to 3.5 please and deliver between 8 PM and 10 PM'
        rows = [update('min_price', 3.5, 'price to 3.5'),
                update('interval_start', '2026-10-28T20:00:00+05:30', 'between 8 PM and 10 PM'),
                update('interval_end', '2026-10-28T22:00:00+05:30', 'between 8 PM and 10 PM')]
        result = self.mod.translate_instruction(phrase, self.agent, client=self.client(translation(rows)))
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['changes']['min_price'], 3.5)
        self.assertEqual(len(result['assumptions']), 2)
        self.assertIn('₹/kWh', result['assumptions'][0])
        self.assertIn('Asia/Kolkata', result['assumptions'][1])

    def test_known_unit_relative_price_cannot_become_an_absolute_floor(self):
        phrase = 'Lower my minimum price by 0.5 please'
        result = self.mod.translate_instruction(phrase, self.agent,
            client=self.client(translation([update('min_price', 0.5, 'minimum price by 0.5', 'set')])))
        self.assertEqual(result['changes'], {})
        self.assertEqual(result['translation']['status'], 'invalid_output')
        self.assertEqual(result['translation']['validation_reason'],
                         'A relative amount cannot be used as an absolute amount')

    def test_model_quote_formatting_preserves_original_meaning(self):
        phrase = 'could you make the minimum price 3.5 for me'
        for quote in ['Make the minimum price 3.5', 'minimum  price\n3.5', 'minimum price 3.5.']:
            with self.subTest(quote=quote):
                self.db = self.db.with_name(str(len(self.calls)) + '.sqlite3')
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([update('min_price', 3.5, quote)])))
                self.assertEqual(result['changes'], {'min_price': 3.5})
                self.assertEqual(result['errors'], [])

    def test_quote_formatting_does_not_remove_units_numbers_or_conditions(self):
        phrase = 'could you make the minimum price 3.5 dollars for me'
        result = self.mod.translate_instruction(phrase, self.agent,
            client=self.client(translation([update('min_price', 3.5, 'Minimum price 3.5.')])))
        self.assertEqual(result['changes'], {})
        phrase = 'could you accept ₹5 per kWh only if 3 kWh is sold together'
        row = update('conditional_price', {'floor':5, 'minimum_kwh':3},
                     'Accept ₹5 per kWh only if 3 kWh is sold together.')
        result = self.mod.translate_instruction(phrase, self.agent, client=self.client(translation([row])))
        self.assertEqual(result['changes'], {'conditional_price': {'floor':5, 'minimum_kwh':3}})

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
        rows = [{'id':a['id'], 'stance':'flexible' if a['role']=='seller' else 'urgent'}
                for a in self.world['agents']]
        client = self.client({'agents':rows})
        plan = self.mod.prepare_strategy_plan(self.world, client=client)
        self.assertEqual(plan['source'], 'llm')
        self.assertEqual(plan['agents']['A17']['price_positions'], [8000,5500,3000])
        self.assertEqual(plan['provenance']['style_choices']['A17'], 'flexible')
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
            ('sell 3 kWh for ₹8 total please', update('min_price',8,'sell 3 kWh for ₹8 total')),
            ('accept ₹5 per kWh if I have 3 guests', update('conditional_price',{'floor':5,'minimum_kwh':3},'accept ₹5 per kWh if I have 3 guests')),
            ('Please keep 3 guests comfortable using 1 kWh', update('reserve_kwh',3,'keep 3 guests comfortable using 1 kWh')),
        ]
        for phrase, row in cases:
            with self.subTest(phrase=phrase):
                result = self.mod.translate_instruction(phrase, self.agent,
                    client=self.client(translation([row])))
                self.assertEqual(result['changes'], {})

    def test_cached_strategy_stays_frozen_if_credential_becomes_unavailable(self):
        rows = [{'id':a['id'], 'stance':'balanced'} for a in self.world['agents']]
        first = self.mod.prepare_strategy_plan(self.world, client=self.client({'agents':rows}))
        disabled = self.mod.LLMClient(api_key='', db_path=self.db)
        self.assertEqual(self.mod.prepare_strategy_plan(self.world, client=disabled), first)


if __name__ == '__main__': unittest.main()
