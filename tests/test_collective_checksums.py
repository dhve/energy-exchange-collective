"""The browser may serialize 1.0 as 1 without changing its numeric value."""
import copy
import hashlib
import json
import unittest

from src.energy_exchange import collective_engine as engine


def browser_round_trip(value):
    # JSON.parse uses one numeric type. JSON.stringify drops integral .0 and -0.
    def browser_number(raw):
        number = float(raw)
        return int(number) if number.is_integer() else number
    return json.loads(json.dumps(value), parse_float=browser_number)


def result_fixture():
    cfg = {'negotiation_mode': 'bargaining', 'topology': 'open'}
    agents = [engine.make_agent('A01', 'seller', forecast_surplus_kwh=4.0,
                               reserve_kwh=-0.0, max_offer_kwh=4.0, min_price=6.0),
              engine.make_agent('A02', 'buyer', demand_kwh=4.0, max_price=8.0, budget=100.0)]
    return engine.run_experiment(cfg, {'agent_id': 'A01', 'scenario': 'custom',
                                      'changes': {'reserve_kwh': 1.0}},
                                 world=engine.make_world(agents, cfg))


def legacy_hash(value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return 'sha256:' + hashlib.sha256(raw.encode('utf-8')).hexdigest()


class CanonicalNumberTests(unittest.TestCase):
    def test_integral_numbers_normalize_recursively_without_mutating_input(self):
        original = {'nested': (1.0, [-0.0, 2.0, 0.25, True]), 'negative': -2.0}
        self.assertEqual(engine.canonical_json(original),
                         '{"negative":-2,"nested":[1,[0,2,0.25,true]]}')
        self.assertIsInstance(original['nested'], tuple)
        self.assertIsInstance(original['nested'][0], float)

    def test_numeric_equivalence_keeps_fractional_changes_and_types_distinct(self):
        self.assertEqual(engine.fingerprint(1.0), engine.fingerprint(1))
        self.assertEqual(engine.fingerprint(-0.0), engine.fingerprint(0))
        self.assertNotEqual(engine.fingerprint(1.01), engine.fingerprint(1))
        self.assertNotEqual(engine.fingerprint(True), engine.fingerprint(1))
        self.assertNotEqual(engine.fingerprint('1'), engine.fingerprint(1))

    def test_browser_round_trip_preserves_all_checksum_verification(self):
        original = result_fixture()
        exported = browser_round_trip(original)
        self.assertIsInstance(original['world']['agents'][0]['min_price'], float)
        self.assertIsInstance(exported['world']['agents'][0]['min_price'], int)
        self.assertEqual(engine.verify_result(exported), [])
        self.assertEqual(exported['manifest']['checksum_version'], 'canonical-json-numbers-v2')

    def test_browser_export_still_detects_meaningful_numeric_tampering(self):
        exported = browser_round_trip(result_fixture())
        for section in ('world', 'events', 'trades'):
            bad = copy.deepcopy(exported)
            if section == 'world':
                bad['world']['agents'][0]['min_price'] += 0.05
                checksum_name = 'world'
            elif section == 'events':
                next(e for e in bad['baseline']['events'] if e['type'] == 'offer_sent')['price'] += 0.05
                checksum_name = 'baseline_events'
            else:
                bad['baseline']['trades'][0]['quantity_kwh'] += 0.01
                checksum_name = 'baseline_trades'
            with self.subTest(section=section):
                self.assertIn(f'manifest checksum mismatch: {checksum_name}', engine.verify_result(bad))

    def test_unversioned_native_checksums_remain_verifiable(self):
        result = result_fixture()
        result['manifest'].pop('checksum_version', None)
        for name, value in {
            'world': result['world'], 'baseline_events': result['baseline']['events'],
            'baseline_trades': result['baseline']['trades'],
            'intervention_events': result['intervention']['events'],
            'intervention_trades': result['intervention']['trades'],
        }.items():
            result['manifest']['checksums'][name] = legacy_hash(value)
        self.assertEqual(engine.verify_result(result), [])
        self.assertIn('manifest checksum mismatch: world',
                      engine.verify_result(browser_round_trip(result)))

    def test_unknown_checksum_version_is_rejected(self):
        result = result_fixture()
        result['manifest']['checksum_version'] = 'unknown-v99'
        self.assertTrue(any('unsupported checksum version' in problem
                            for problem in engine.verify_result(result)))

    def test_legacy_plan_with_integral_float_metadata_replays_exactly(self):
        fixture = result_fixture()
        strategy = copy.deepcopy(fixture['manifest']['strategy_plan'])
        strategy['provider_metadata'] = {'attempts': 1.0, 'saved_cost': -0.0}
        legacy = engine.run_experiment(fixture['manifest']['config'], fixture['manifest']['intervention'],
                                       world=fixture['world'], strategy_plan=strategy,
                                       checksum_version='python-json-v1')
        self.assertEqual(legacy['manifest']['strategy_plan_hash'], legacy_hash(strategy))
        legacy['manifest'].pop('checksum_version')
        self.assertEqual(engine.verify_result(legacy), [])
        self.assertEqual(legacy['baseline']['trades'], fixture['baseline']['trades'])
        self.assertEqual(legacy['intervention']['trades'], fixture['intervention']['trades'])
