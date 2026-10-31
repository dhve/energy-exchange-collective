import unittest
from fastapi.testclient import TestClient
from src.energy_exchange.collective_server import create_app, Intervention, Config, Changes
from src.energy_exchange.collective_engine import strip_runtime, verify_result


class CollectiveServerTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app())

    def test_actual_experiment_is_deterministic(self):
        payload = {'config': {'population': 20, 'seed': 42}}
        a = self.client.post('/api/experiment', json=payload)
        b = self.client.post('/api/experiment', json=payload)
        self.assertEqual(a.status_code, 200, a.text)
        self.assertEqual(strip_runtime(a.json()), strip_runtime(b.json()))
        self.assertEqual(len(a.json()['world']['agents']), 20)
        self.assertEqual(verify_result(a.json()), [])

    def test_confirmed_no_change_preserves_stable_allocation(self):
        r = self.client.post('/api/experiment', json={'config': {'population': 20},
            'intervention': {'agent_id': 'A17', 'scenario': 'custom',
                             'changes': {'min_price': 6.5}, 'confirmed': True}})
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()
        self.assertEqual(result['comparison']['changed_trades'], 0)
        self.assertEqual(result['comparison']['affected_agents'], [])
        self.assertEqual(verify_result(result), [])

    def test_confirmation_required_for_any_intervention(self):
        r = self.client.post('/api/experiment', json={'intervention':
            {'agent_id': 'A17', 'scenario': 'custom', 'changes': {'min_price': 8}}})
        self.assertEqual(r.status_code, 422)

    def test_confirmation_requires_boolean_true_not_numeric_one(self):
        with self.assertRaises(ValueError):
            Intervention.model_validate({'scenario': 'none', 'confirmed': 1})

    def test_policy_is_preview_only(self):
        r = self.client.post('/api/policy', json={'config': {'population': 20},
            'agent_id': 'A17', 'text': 'Raise my minimum price to ₹8/kWh'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['changes'], {'min_price': 8})
        self.assertTrue(r.json()['requires_confirmation'])
        self.assertNotIn('intervention', r.json())

    def test_unknown_fields_and_bad_numbers(self):
        for config in [{'population': 21}, {'seed': True}, {'max_rounds': 1000},
                       {'utility_cap_kwh': -1}, {'topology': 'physical'}, {'plugin_files': ['x']},
                       {'price_tick': 0}]:
            with self.subTest(config=config):
                self.assertEqual(self.client.post('/api/experiment', json={'config': config}).status_code, 422)

    def test_malformed_and_oversized_input(self):
        self.assertEqual(self.client.post('/api/experiment', content='x').status_code, 415)
        self.assertEqual(self.client.post('/api/experiment', content='no', headers={'content-type': 'application/json'}).status_code, 422)
        self.assertEqual(self.client.post('/api/experiment', content='x'*40000, headers={'content-type': 'application/json'}).status_code, 413)

    def test_cross_origin_rejected(self):
        r = self.client.post('/api/experiment', json={}, headers={'origin': 'https://elsewhere.example'})
        self.assertEqual(r.status_code, 403)

    def test_assets_and_health_do_not_expose_local_data(self):
        self.assertEqual(self.client.get('/healthz').json()['mode'], 'synthetic')
        for path in ['/assets/server.py', '/assets/../collective_server.py', '/.git/config', '/context/_chat.txt']:
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_main_app_uses_bargaining_and_can_compare_midpoint(self):
        self.assertEqual(Config().model_dump().get('negotiation_mode'), 'bargaining')
        r = self.client.post('/api/experiment', json={'config': {'population':20, 'negotiation_mode':'midpoint'}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['manifest']['config']['negotiation_mode'], 'midpoint')

    def test_time_price_condition_is_preserved_in_confirmed_input(self):
        parsed = Changes.model_validate({'time_price': {'after':'2026-10-28T15:00:00+05:30','floor':6.0}})
        self.assertEqual(parsed.model_dump(exclude_unset=True)['time_price']['floor'], 6)

    def test_client_cannot_select_llm_credentials_or_model(self):
        for config in [{'api_key':'fake'}, {'llm_model':'expensive-model'}, {'negotiation_mode':'invented'}]:
            self.assertEqual(self.client.post('/api/experiment', json={'config':config}).status_code, 422)

    def test_comparison_runs_both_methods_on_the_exact_same_world(self):
        from src.energy_exchange.collective_engine import run_experiment
        from src.energy_exchange.collective_server import execute_task
        config = Config(population=20).model_dump()
        change = {'agent_id':'A17', 'scenario':'custom', 'changes':{'reserve_kwh':3}}
        result = execute_task({'task':'experiment','config':config,'intervention':change})
        comparison = result.get('method_comparison')
        self.assertIsNotNone(comparison)
        self.assertEqual(comparison['world_checksum'], result['manifest']['checksums']['world'])
        midpoint = run_experiment({**config,'negotiation_mode':'midpoint'}, change, world=result['world'])
        for stage in ['baseline','intervention']:
            for key in ['committed_kwh','unfilled_demand_kwh','payments','message_count']:
                self.assertEqual(comparison[stage]['bargaining'][key], result[stage]['metrics'][key])
                self.assertEqual(comparison[stage]['midpoint'][key], midpoint[stage]['metrics'][key])


if __name__ == '__main__':
    unittest.main()
