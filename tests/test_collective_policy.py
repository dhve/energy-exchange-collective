import copy
import unittest

from src.energy_exchange import collective_policy as policy


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.seller = dict(id='A17', role='seller', min_price=6, max_offer_kwh=5,
                           forecast_surplus_kwh=8, reserve_kwh=2,
                           interval_start='2026-10-28T14:00:00+05:30',
                           interval_end='2026-10-28T16:00:00+05:30')
        self.buyer = dict(id='A02', role='buyer', demand_kwh=4, max_price=9,
                          budget=40, interval_start=self.seller['interval_start'],
                          interval_end=self.seller['interval_end'])

    def test_conditional_offer_keeps_every_condition(self):
        result = policy.parse_instruction(
            'Sell up to 4 kWh from 2–4 PM at at least ₹7/kWh; '
            'accept ₹6.50 only if at least 3 kWh is sold together.', self.seller)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['changes']['max_offer_kwh'], 4)
        self.assertEqual(result['changes']['min_price'], 7)
        self.assertEqual(result['changes']['conditional_price'],
                         {'floor': 6.5, 'minimum_kwh': 3})
        self.assertEqual(result['changes']['interval_start'], self.seller['interval_start'])
        self.assertTrue(result['requires_confirmation'])

    def test_unsupported_condition_never_executes_partial_parse(self):
        result = policy.parse_instruction('Sell up to 4 kWh at at least ₹7/kWh unless it rains.', self.seller)
        self.assertTrue(result['errors'])
        self.assertEqual(result['changes'], {})

    def test_parse_does_not_mutate_profile(self):
        original = copy.deepcopy(self.seller)
        policy.parse_instruction('Raise my minimum price to ₹8/kWh', self.seller)
        self.assertEqual(self.seller, original)

    def test_negative_or_conflicting_values_rejected(self):
        for text in ['Sell up to -4 kWh', 'Set my minimum price to ₹7 and set my minimum price to ₹9',
                     'Sell up to 4 kWh at at least ₹7/kWh; accept ₹8 only if at least 3 kWh is sold together']:
            with self.subTest(text=text):
                result = policy.parse_instruction(text, self.seller)
                self.assertTrue(result['errors'])
                self.assertEqual(result['changes'], {})

    def test_role_mismatch_rejected(self):
        self.assertTrue(policy.parse_instruction('Buy 5 kWh at at most ₹8/kWh', self.seller)['errors'])
        self.assertTrue(policy.parse_instruction('Sell up to 4 kWh', self.buyer)['errors'])

    def test_buyer_demand_price_and_budget(self):
        result = policy.parse_instruction('Buy 5 kWh at at most ₹8/kWh with a budget of ₹35', self.buyer)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['changes'], {'demand_kwh': 5, 'max_price': 8, 'budget': 35})

    def test_time_outside_demo_interval_is_explicitly_rejected(self):
        result = policy.parse_instruction('Sell up to 4 kWh from 3-5 PM at at least ₹7/kWh', self.seller)
        self.assertTrue(result['errors'])

    def test_simple_budget_and_deadline(self):
        result = policy.parse_instruction('Set my budget to INR 30 and my deadline to round 6', self.buyer)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['changes'], {'budget': 30, 'deadline_round': 6})

    def test_unknown_agent_and_nonstring_input(self):
        self.assertTrue(policy.parse_instruction('Set my budget to 30', {})['errors'])
        self.assertTrue(policy.parse_instruction(None, self.seller)['errors'])

    def test_previews_respect_http_field_limits(self):
        for text, agent in [('Set my minimum price to INR 101', self.seller),
                            ('Sell up to 1001 kWh', self.seller),
                            ('Set my surplus to 1001 kWh', self.seller),
                            ('Buy 1001 kWh', self.buyer),
                            ('Set my maximum price to INR 101', self.buyer)]:
            with self.subTest(text=text):
                result = policy.parse_instruction(text, agent)
                self.assertTrue(result['errors'])
                self.assertEqual(result['changes'], {})

    def test_huge_deadline_reports_error_instead_of_crashing(self):
        result = policy.parse_instruction('Set my deadline to round ' + '9'*310, self.buyer)
        self.assertTrue(result['errors'])
        self.assertEqual(result['changes'], {})

    def test_existing_bundle_is_validated_after_each_change(self):
        self.seller.update(min_price=7, max_offer_kwh=4,
                           conditional_price={'floor': 6.5, 'minimum_kwh': 3})
        for text in ['Set my minimum price to INR 6', 'Sell up to 2 kWh']:
            with self.subTest(text=text):
                self.assertTrue(policy.parse_instruction(text, self.seller)['errors'])
        result = policy.parse_instruction('Remove my bundle discount and sell up to 2 kWh', self.seller)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['changes'], {'conditional_price': None, 'max_offer_kwh': 2})

    def test_bundle_requires_a_discount_below_the_standard_floor(self):
        result = policy.parse_instruction('Set my minimum price to INR 7; accept INR 7 only if at least 3 kWh is sold together', self.seller)
        self.assertTrue(result['errors'])
        self.assertEqual(result['changes'], {})

    def test_prices_and_money_match_engine_units(self):
        for text, agent in [('Set my minimum price to INR 7.03', self.seller),
                            ('Set my budget to INR 0.001', self.buyer),
                            ('Sell up to 0.0001 kWh', self.seller)]:
            with self.subTest(text=text):
                self.assertTrue(policy.parse_instruction(text, agent)['errors'])


if __name__ == '__main__':
    unittest.main()
