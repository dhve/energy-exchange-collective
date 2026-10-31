"""The Streamlit transport must enforce the same boundary as HTTP."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from src.energy_exchange.collective_server import create_app


class CollectiveStreamlitTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.find_spec('src.energy_exchange.collective_streamlit')
        self.assertIsNotNone(spec, 'The shared Streamlit request adapter must exist')
        from src.energy_exchange import collective_streamlit
        self.host = collective_streamlit
        self.session = {}

    def request(self, path, payload, request_id='request_1'):
        return self.host.handle_request({'id': request_id, 'path': path, 'payload': payload}, self.session)

    def test_actual_policy_preview_uses_shared_parser(self):
        response, changed = self.request('/api/policy', {'config': {'population': 20},
            'agent_id': 'A17', 'text': 'Set my minimum price to INR 8'})
        self.assertTrue(changed)
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['body']['changes'], {'min_price': 8})
        self.assertTrue(response['body']['requires_confirmation'])

    def test_actual_experiment_and_confirmed_policy_use_same_engine(self):
        response, _ = self.request('/api/experiment', {'config': {'population': 20},
            'intervention': {'agent_id': 'A17', 'scenario': 'custom',
                'changes': {'min_price': 8}, 'confirmed': True}})
        self.assertEqual(response['status'], 200, response)
        self.assertEqual(len(response['body']['world']['agents']), 20)
        changed = response['body']['manifest']['changed_fields']
        self.assertIn({'agent_id': 'A17', 'field': 'min_price', 'before': 6.5, 'after': 8}, changed)

    def test_unconfirmed_and_nonboolean_confirmation_are_rejected(self):
        for flag in [None, False, 1, 'true']:
            intervention = {'agent_id': 'A17', 'scenario': 'custom', 'changes': {'min_price': 8}}
            if flag is not None: intervention['confirmed'] = flag
            response, _ = self.request('/api/experiment', {'intervention': intervention}, 'id_'+str(flag))
            self.assertEqual(response['status'], 422)

    def test_unknown_route_fields_bounds_and_oversize_are_rejected(self):
        for i, (path, payload) in enumerate([('/api/shell', {}), ('/api/experiment', {'plugin_files': ['x']}),
                ('/api/experiment', {'config': {'seed': True}}),
                ('/api/experiment', {'config': {'max_rounds': 51}})]):
            with self.subTest(path=path,payload=payload):
                response, _ = self.request(path, payload, 'invalid_'+str(i))
                self.assertEqual(response['status'], 422)
        response, _ = self.request('/api/policy', {'text': 'x'*40000}, 'oversize')
        self.assertEqual(response['status'], 413)

    def test_rerun_deduplicates_request_and_rejects_reused_id(self):
        fake = AsyncMock(return_value={'changes': {}, 'errors': ['unsupported'], 'requires_confirmation': True})
        with patch.object(self.host, 'worker', fake):
            first, changed = self.request('/api/policy', {'text': 'anything'})
            second, repeated = self.request('/api/policy', {'text': 'anything'})
            conflict, _ = self.request('/api/policy', {'text': 'different'})
        self.assertTrue(changed)
        self.assertFalse(repeated)
        self.assertEqual(first, second)
        self.assertEqual(fake.await_count, 1, 'A Streamlit rerun must not execute the worker again')
        self.assertEqual(conflict['status'], 409)

    def test_worker_timeout_is_a_response_and_session_state_is_separate(self):
        from fastapi import HTTPException
        with patch.object(self.host, 'worker', AsyncMock(side_effect=HTTPException(504, 'Timed out'))):
            response, _ = self.request('/api/experiment', {})
        self.assertEqual(response['status'], 504)
        other = {}
        with patch.object(self.host, 'worker', AsyncMock(return_value={'ok': True})):
            response, changed = self.host.handle_request({'id':'request_1','path':'/api/experiment','payload':{}}, other)
        self.assertTrue(changed)
        self.assertEqual(response['status'], 200)

    def test_server_credentials_never_enter_component_payload_or_session(self):
        secret_env = {'OPENAI_API_KEY':'private-test-key'}
        fake = AsyncMock(return_value={'ok':True})
        with patch.object(self.host, 'worker', fake):
            response, _ = self.host.handle_request(
                {'id':'secret-test','path':'/api/experiment','payload':{}}, self.session, secret_env)
        payload, environment = fake.await_args.args
        self.assertEqual(environment, secret_env)
        self.assertNotIn('private-test-key', str(payload))
        self.assertNotIn('private-test-key', str(response))
        self.assertNotIn('private-test-key', str(self.session))

    def test_same_single_entry_and_relative_assets_work_in_http_host(self):
        from html.parser import HTMLParser
        class Assets(HTMLParser):
            def __init__(self): super().__init__(); self.assets=[]
            def handle_starttag(self, tag, attrs):
                attrs=dict(attrs)
                if tag=='script': self.assets.append(attrs.get('src'))
                if tag=='link' and attrs.get('rel')=='stylesheet': self.assets.append(attrs.get('href'))
        client=TestClient(create_app())
        response=client.get('/')
        self.assertEqual(response.status_code,200)
        parser=Assets(); parser.feed(response.text)
        self.assertGreaterEqual(len(parser.assets),3)
        for asset in parser.assets:
            self.assertIsNotNone(asset,'Inline scripts are not needed')
            self.assertFalse(asset.startswith(('/', 'http:', 'https:', '//')))
            self.assertEqual(client.get('/'+asset).status_code,200)
        web=Path(self.host.WEB)
        self.assertEqual(response.text,(web/'index.html').read_text())
        self.assertFalse((web/'collective.html').exists(),'There must be one HTML source')


if __name__=='__main__': unittest.main()
