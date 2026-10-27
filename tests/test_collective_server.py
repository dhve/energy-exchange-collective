import unittest
from fastapi.testclient import TestClient
from src.energy_exchange.collective_server import create_app, Intervention
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


if __name__ == '__main__':
    unittest.main()
