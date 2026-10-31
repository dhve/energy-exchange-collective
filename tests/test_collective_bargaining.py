"""Delivery and bargaining fixtures with hand-computed accepted terms."""
import copy
import unittest

from src.energy_exchange import collective_engine as engine


def seller(**extra):
    fields = dict(forecast_surplus_kwh=4, reserve_kwh=0, max_offer_kwh=4,
                  min_price=6)
    fields.update(extra)
    return engine.make_agent('A01', 'seller', **fields)


def buyer(aid='A02', **extra):
    fields = dict(demand_kwh=4, max_price=8, budget=100)
    fields.update(extra)
    return engine.make_agent(aid, 'buyer', **fields)


def experiment(agents, intervention=None, plan=None, **options):
    cfg = dict(topology='open', **options)
    world = engine.make_world(agents, cfg)
    if plan is None:
        return engine.run_experiment(cfg, intervention, world=world)
    return engine.run_experiment(cfg, intervention, world=world, strategy_plan=plan)


class DeliveryWindowTests(unittest.TestCase):
    def test_partial_overlap_uses_intersection_without_inventing_power_limit(self):
        result = experiment([seller(), buyer(interval_start='2026-10-28T15:00:00+05:30',
                                             interval_end='2026-10-28T17:00:00+05:30')])
        self.assertEqual(len(result['baseline']['trades']), 1)
        trade = result['baseline']['trades'][0]
        self.assertEqual((trade['delivery_start'], trade['delivery_end']),
                         ('2026-10-28T15:00:00+05:30', '2026-10-28T16:00:00+05:30'))
        self.assertEqual(trade['quantity_kwh'], 4)
        self.assertEqual(engine.verify_result(result), [])

    def test_touching_windows_do_not_trade(self):
        result = experiment([seller(), buyer(interval_start='2026-10-28T16:00:00+05:30',
                                             interval_end='2026-10-28T18:00:00+05:30')])
        self.assertEqual(result['baseline']['trades'], [])

    def test_invalid_or_naive_windows_are_rejected(self):
        for start, end in [('not-a-date', 'later'),
                           ('2026-10-28T14:00:00', '2026-10-28T16:00:00'),
                           ('2026-10-28T16:00:00+05:30', '2026-10-28T14:00:00+05:30')]:
            with self.subTest(start=start), self.assertRaises(ValueError):
                experiment([seller(interval_start=start, interval_end=end), buyer()])

    def test_late_floor_selects_real_later_delivery_segment(self):
        result = experiment([seller(min_price=9, time_price={
            'after': '2026-10-28T15:00:00+05:30', 'floor': 6}), buyer()])
        self.assertEqual(len(result['baseline']['trades']), 1)
        trade = result['baseline']['trades'][0]
        self.assertEqual(trade['delivery_start'], '2026-10-28T15:00:00+05:30')
        self.assertEqual(trade['delivery_end'], '2026-10-28T16:00:00+05:30')
        self.assertEqual(trade['price'], 7)
        self.assertEqual(trade['effective_floor'], 6)
        self.assertEqual(engine.verify_result(result), [])


def plan(agents, seller_positions=(9000, 7000, 6000), buyer_positions=(1000, 3000, 7000)):
    return {'version': 'bounded-price-plan-v1', 'source': 'test', 'agents': {
        a['id']: {'price_positions': list(seller_positions if a['role'] == 'seller'
                                         else buyer_positions)} for a in agents}}


class BargainingTests(unittest.TestCase):
    def test_real_price_counteroffers_end_at_accepted_quote(self):
        agents = [seller(), buyer()]
        result = experiment(agents, plan=plan(agents), negotiation_mode='bargaining')
        events = result['baseline']['events']
        prices = [e['price'] for e in events if e['type'] in engine.MESSAGE_TYPES
                  and 'price' in e]
        self.assertGreater(len(set(prices)), 1)
        self.assertTrue(any(e['type'] == 'counteroffer_sent' for e in events))
        trade = result['baseline']['trades'][0]
        self.assertEqual(trade['price'], 7.2)
        accepted = next(e for e in events if e['type'] == 'offer_accepted')
        self.assertEqual(accepted['price'], trade['price'])
        self.assertEqual(accepted['quantity_kwh'], trade['quantity_kwh'])
        self.assertEqual(engine.verify_result(result), [])

    def test_plan_changes_realized_price_and_can_fail_to_agree(self):
        agents = [seller(), buyer()]
        first = experiment(agents, plan=plan(agents), negotiation_mode='bargaining')
        second = experiment(agents, plan=plan(agents, (8000, 6000, 4000), (2000, 4000, 5000)),
                            negotiation_mode='bargaining')
        refused = experiment(agents, plan=plan(agents, (9000, 9000, 9000), (1000, 1000, 1000)),
                             negotiation_mode='bargaining')
        self.assertNotEqual(first['baseline']['trades'][0]['price'],
                            second['baseline']['trades'][0]['price'])
        self.assertEqual(refused['baseline']['trades'], [])
        self.assertEqual(refused['baseline']['status'], 'locally_stable')

    def test_plan_is_frozen_and_noop_preserves_allocation(self):
        agents = [seller(), buyer()]
        strategy = plan(agents)
        before = copy.deepcopy(strategy)
        result = experiment(agents, {'agent_id': 'A01', 'scenario': 'custom',
                                    'changes': {'reserve_kwh': 0}}, strategy,
                            negotiation_mode='bargaining')
        self.assertEqual(result['comparison']['changed_trades'], 0)
        self.assertEqual(result['manifest']['strategy_plan'], before)
        self.assertEqual(strategy, before)
        self.assertEqual(engine.verify_result(result), [])

    def test_bargaining_message_limits_leave_valid_atomic_state(self):
        agents = [seller(), buyer()]
        for limit in range(8):
            with self.subTest(limit=limit):
                result = experiment(agents, plan=plan(agents), negotiation_mode='bargaining',
                                    max_messages=limit)
                self.assertLessEqual(result['baseline']['messages'], limit)
                self.assertEqual(engine.verify_result(result), [])

    def test_invalid_strategies_are_rejected(self):
        agents = [seller(), buyer()]
        for values in ([9000, 5000], [9000, 3000, 5000], [10001, 5000, 0], [True, 0, 0]):
            bad = plan(agents)
            bad['agents']['A01']['price_positions'] = values
            with self.subTest(values=values), self.assertRaises(ValueError):
                experiment(agents, plan=bad, negotiation_mode='bargaining')

    def test_smaller_bundle_counteroffer_cannot_keep_discount(self):
        agents = [seller(min_price=9, conditional_price={'floor': 6, 'minimum_kwh': 3}),
                  buyer(max_price=8, budget=13)]
        result = experiment(agents, plan=plan(agents), negotiation_mode='bargaining')
        self.assertEqual(result['baseline']['trades'], [])
        self.assertTrue(any(e['type'] == 'offer_rejected' for e in result['baseline']['events']))
        self.assertEqual(engine.verify_result(result), [])

    def test_buyer_initiated_session_reduces_quantity_when_seller_price_rises(self):
        selling = seller()
        selling['id'] = 'A02'
        agents = [buyer('A01', budget=13), selling]
        result = experiment(agents, plan=plan(agents), negotiation_mode='bargaining', max_messages=7)
        self.assertEqual(len(result['baseline']['trades']), 1)
        self.assertLessEqual(result['baseline']['trades'][0]['payment'], 13)
        self.assertEqual(engine.verify_result(result), [])

    def test_one_household_reserve_intervention_preserves_other_policies_and_plan(self):
        agents = [seller(), buyer()]
        result = experiment(agents, {'agent_id': 'A01', 'scenario': 'custom',
                                    'changes': {'reserve_kwh': 2}}, plan(agents),
                            negotiation_mode='bargaining')
        self.assertEqual(result['world']['agents'][1], result['updated_world']['agents'][1])
        self.assertEqual(result['baseline']['strategy_plan'], result['intervention']['strategy_plan'])
        self.assertEqual(result['intervention']['metrics']['committed_kwh'], 2)
        self.assertEqual(result['manifest']['changed_fields'], [
            {'agent_id': 'A01', 'field': 'reserve_kwh', 'before': 0, 'after': 2}])
        self.assertEqual(engine.verify_result(result), [])

    def test_replay_rejects_forged_acceptance_even_with_recomputed_checksum(self):
        agents = [seller(), buyer()]
        result = experiment(agents, plan=plan(agents), negotiation_mode='bargaining')
        accepted = next(e for e in result['baseline']['events'] if e['type'] == 'offer_accepted')
        accepted['price'] = 7.15
        result['manifest']['checksums']['baseline_events'] = engine.fingerprint(result['baseline']['events'])
        self.assertTrue(engine.verify_result(result))

    def test_replay_handles_malformed_delivery_and_rejects_strategy_tampering(self):
        agents = [seller(time_price={'after': '2026-10-28T15:00:00+05:30', 'floor': 5}), buyer()]
        result = experiment(agents, plan=plan(agents), negotiation_mode='bargaining')
        bad = copy.deepcopy(result)
        bad['baseline']['trades'][0]['delivery_start'] = 'bad timestamp'
        self.assertTrue(engine.verify_result(bad))
        bad = copy.deepcopy(result)
        bad['manifest']['strategy_plan']['agents']['A01']['price_positions'] = [9000, 8000, 7000]
        self.assertTrue(engine.verify_result(bad))

    def test_flexible_pool_is_not_duplicated_across_partners(self):
        result = experiment([seller(), buyer(demand_kwh=3), buyer('A04', demand_kwh=3)],
                            negotiation_mode='bargaining')
        self.assertEqual(result['baseline']['metrics']['committed_kwh'], 4)
        self.assertEqual(result['baseline']['metrics']['unfilled_demand_kwh'], 2)
        self.assertEqual(engine.verify_result(result), [])

    def test_interval_only_intervention_is_visible_and_repaired(self):
        result = experiment([seller(), buyer()], {'agent_id': 'A02', 'scenario': 'custom',
                            'changes': {'interval_start': '2026-10-28T15:00:00+05:30',
                                        'interval_end': '2026-10-28T17:00:00+05:30'}},
                            negotiation_mode='bargaining')
        self.assertEqual(result['comparison']['changed_trades'], 2)
        self.assertEqual(result['intervention']['trades'][0]['delivery_start'],
                         '2026-10-28T15:00:00+05:30')
        self.assertEqual(engine.verify_result(result), [])

    def test_time_discount_is_unavailable_before_boundary(self):
        result = experiment([seller(min_price=9, time_price={
            'after': '2026-10-28T15:00:00+05:30', 'floor': 6}),
            buyer(interval_end='2026-10-28T15:00:00+05:30')], negotiation_mode='bargaining')
        self.assertEqual(result['baseline']['trades'], [])

    def test_invalid_time_discounts_and_buyer_seller_policy_are_rejected(self):
        for timed in ({'after': '2026-10-28T15:00:00', 'floor': 5},
                      {'after': '2026-10-28T17:00:00+05:30', 'floor': 5},
                      {'after': '2026-10-28T15:00:00+05:30', 'floor': 7},
                      {'after': '2026-10-28T15:00:00+05:30', 'floor': 5.03}):
            with self.subTest(timed=timed), self.assertRaises(ValueError):
                experiment([seller(time_price=timed), buyer()])
        with self.assertRaises(ValueError):
            experiment([seller(), buyer(time_price={
                'after': '2026-10-28T15:00:00+05:30', 'floor': 5})])

    def test_equivalent_timezone_offsets_have_identical_delivery(self):
        result = experiment([seller(), buyer(interval_start='2026-10-28T09:30:00+00:00',
                                             interval_end='2026-10-28T11:30:00+00:00')])
        self.assertEqual(result['baseline']['trades'][0]['delivery_start'],
                         '2026-10-28T15:00:00+05:30')

    def test_bundle_flag_describes_final_discounted_price(self):
        agents = [seller(min_price=7, conditional_price={'floor': 6, 'minimum_kwh': 3}), buyer()]
        result = experiment(agents, plan=plan(agents, (9000, 4000, 3000), (1000, 2000, 3000)),
                            negotiation_mode='bargaining')
        trade = result['baseline']['trades'][0]
        self.assertEqual(trade['price'], 6.6)
        self.assertTrue(trade['bundle'])
        self.assertEqual(engine.verify_result(result), [])

    def test_bargaining_world_has_seeded_time_preferences_without_changing_a17(self):
        world = engine.build_world({'population': 50, 'seed': 42, 'negotiation_mode': 'bargaining'})
        again = engine.build_world({'population': 50, 'seed': 42, 'negotiation_mode': 'bargaining'})
        original = engine.build_world({'population': 50, 'seed': 42})
        self.assertEqual(world, again)
        self.assertGreater(len({(a['interval_start'], a['interval_end']) for a in world['agents']}), 1)
        by_id = {a['id']: a for a in world['agents']}
        original_by_id = {a['id']: a for a in original['agents']}
        self.assertEqual(by_id['A17'], original_by_id['A17'])
        self.assertEqual(by_id['A20']['interval_start'], '2026-10-28T20:00:00+05:30')
        self.assertEqual(by_id['A15']['time_price']['after'], '2026-10-28T21:00:00+05:30')
        self.assertEqual(world['interval']['end'], '2026-10-28T22:00:00+05:30')
        self.assertTrue(all(a['time_price'] is None for a in original['agents']))

    def test_window_rejection_answers_an_actual_recorded_offer(self):
        result = experiment([seller(), buyer(interval_start='2026-10-28T16:00:00+05:30',
                                             interval_end='2026-10-28T18:00:00+05:30')],
                            negotiation_mode='bargaining')
        events = {e['id']: e for e in result['baseline']['events']}
        rejection = next(e for e in events.values() if e['type'] == 'offer_rejected')
        self.assertEqual(events[rejection['caused_by'][0]]['type'], 'offer_sent')
        self.assertEqual(rejection['reason_code'], 'interval_mismatch')
