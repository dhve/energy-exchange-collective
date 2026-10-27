"""Hand-checked fixtures for the collective negotiation engine.

Every number in these tests was computed by hand from the rules in
README-COLLECTIVE.md: midpoint price rounded half up to the tick,
whole paise money, whole watt-hour energy, and surplus utility.
"""

import copy
import json
import unittest

from src.energy_exchange import collective_engine as engine

INTERVAL = {
    "interval_start": "2026-10-28T14:00:00+05:30",
    "interval_end": "2026-10-28T16:00:00+05:30",
    "timezone": "Asia/Kolkata",
}


def seller(agent_id, max_offer=4.0, min_price=6.0, forecast=None, reserve=0.0,
           conditional=None, deadline=None, memory=None, **extra):
    fields = dict(
        forecast_surplus_kwh=max_offer + reserve if forecast is None else forecast,
        reserve_kwh=reserve,
        max_offer_kwh=max_offer,
        min_price=min_price,
        conditional_price=conditional,
        deadline_round=deadline,
        memory=memory or [],
    )
    fields.update(extra)
    return engine.make_agent(agent_id, "seller", **fields)


def buyer(agent_id, demand=4.0, max_price=7.0, budget=1000.0, deadline=None,
          memory=None, **extra):
    fields = dict(demand_kwh=demand, max_price=max_price, budget=budget,
                  deadline_round=deadline, memory=memory or [])
    fields.update(extra)
    return engine.make_agent(agent_id, "buyer", **fields)


def config(**over):
    cfg = engine.default_config()
    cfg.update(over)
    return cfg


def run(agents, intervention=None, **over):
    cfg = config(topology="open", **over)
    world = engine.make_world(agents, cfg)
    return engine.run_experiment(cfg, intervention, world=world)


def events_of(result, run_name, kind=None):
    events = result[run_name]["events"]
    return [e for e in events if kind is None or e["type"] == kind]


def trades_of(result, run_name):
    return [(t["seller_id"], t["buyer_id"], t["quantity_kwh"], t["price"])
            for t in result[run_name]["trades"]]


class PriceRuleTests(unittest.TestCase):
    def test_midpoint_rounds_half_up_to_tick_and_stays_in_band(self):
        self.assertEqual(engine.price_paise(600, 700, 5), 650)
        self.assertEqual(engine.price_paise(650, 680, 5), 665)
        self.assertEqual(engine.price_paise(600, 605, 5), 605)
        self.assertIsNone(engine.price_paise(700, 680, 5))

    def test_payment_rounds_half_up_to_paise(self):
        self.assertEqual(engine.payment_paise(3500, 665), 2328)
        self.assertEqual(engine.payment_paise(3000, 650), 1950)

    def test_affordable_quantity_never_exceeds_budget(self):
        wh = engine.affordable_wh(1500, 665)
        self.assertLessEqual(engine.payment_paise(wh, 665), 1500)
        self.assertGreater(engine.payment_paise(wh + 10, 665), 1500)

    def test_state_hash_is_order_independent_and_sensitive(self):
        a = {"seller_id": "A01", "buyer_id": "A02", "wh": 3000, "paise": 650, "bundle": False}
        b = {"seller_id": "A03", "buyer_id": "A04", "wh": 1000, "paise": 700, "bundle": False}
        self.assertEqual(engine.state_hash([a, b]), engine.state_hash([b, a]))
        self.assertNotEqual(engine.state_hash([a]), engine.state_hash([a, b]))


class SinglePairTests(unittest.TestCase):
    def test_single_pair_fills_at_midpoint(self):
        result = run([seller("A01", max_offer=4.0, min_price=6.0),
                      buyer("A02", demand=3.0, max_price=7.0, budget=100.0)])
        base = result["baseline"]
        self.assertEqual(base["status"], "locally_stable")
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A02", 3.0, 6.5)])
        trade = base["trades"][0]
        self.assertAlmostEqual(trade["payment"], 19.5)
        self.assertEqual(trade["status"], "committed")
        self.assertAlmostEqual(base["metrics"]["welfare"], 3.0)
        self.assertAlmostEqual(base["agents"]["A01"]["utility"], 1.5)
        self.assertAlmostEqual(base["agents"]["A02"]["utility"], 1.5)
        self.assertEqual(engine.verify_result(result), [])

    def test_reserve_limits_seller_offer(self):
        result = run([seller("A01", max_offer=4.0, min_price=6.0, forecast=5.0, reserve=2.0),
                      buyer("A02", demand=5.0, max_price=7.0, budget=100.0)])
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A02", 3.0, 6.5)])

    def test_budget_limits_quantity_with_counteroffer(self):
        result = run([seller("A01", max_offer=4.0, min_price=6.0),
                      buyer("A02", demand=4.0, max_price=7.0, budget=13.0)])
        counters = events_of(result, "baseline", "counteroffer_sent")
        self.assertEqual(len(counters), 1)
        counter = counters[0]
        self.assertEqual((counter["actor_id"], counter["counterparty_id"]), ("A02", "A01"))
        self.assertEqual(counter["reason_code"], "over_budget")
        self.assertAlmostEqual(counter["quantity_kwh"], 2.0)
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A02", 2.0, 6.5)])
        self.assertAlmostEqual(result["baseline"]["trades"][0]["payment"], 13.0)

    def test_zero_surplus_pair_does_not_trade(self):
        result = run([seller("A01", max_offer=4.0, min_price=6.0),
                      buyer("A02", demand=3.0, max_price=6.0, budget=100.0)])
        self.assertEqual(result["baseline"]["trades"], [])
        self.assertEqual(events_of(result, "baseline", "offer_sent"), [])
        self.assertEqual(result["baseline"]["status"], "locally_stable")

    def test_half_tick_midpoint_rounds_up_but_stays_within_maximum(self):
        result = run([seller("A01", max_offer=4.0, min_price=6.0),
                      buyer("A02", demand=3.0, max_price=6.05, budget=100.0)])
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A02", 3.0, 6.05)])

    def test_interval_mismatch_is_rejected_explicitly(self):
        result = run([seller("A01"),
                      buyer("A02", interval_start="2026-10-28T16:00:00+05:30",
                            interval_end="2026-10-28T18:00:00+05:30")])
        rejected = events_of(result, "baseline", "offer_rejected")
        self.assertTrue(rejected)
        self.assertEqual(rejected[0]["reason_code"], "interval_mismatch")
        self.assertEqual(result["baseline"]["trades"], [])
        self.assertEqual(result["baseline"]["status"], "locally_stable")

    def test_deadline_passed_is_rejected(self):
        result = run([seller("A01"), buyer("A02", deadline=0)])
        rejected = events_of(result, "baseline", "offer_rejected")
        self.assertTrue(rejected)
        self.assertEqual(rejected[0]["reason_code"], "deadline_passed")
        self.assertEqual(result["baseline"]["trades"], [])


class BundleTests(unittest.TestCase):
    def test_bundle_price_applies_at_or_above_minimum_quantity(self):
        result = run([seller("A01", max_offer=4.0, min_price=7.0,
                             conditional={"floor": 6.5, "minimum_kwh": 3.0}),
                      buyer("A02", demand=3.5, max_price=6.8, budget=100.0)])
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A02", 3.5, 6.65)])
        trade = result["baseline"]["trades"][0]
        self.assertTrue(trade["bundle"])
        self.assertAlmostEqual(trade["payment"], 23.28)
        self.assertEqual(engine.verify_result(result), [])

    def test_bundle_not_offered_below_minimum_quantity(self):
        result = run([seller("A01", max_offer=4.0, min_price=7.0,
                             conditional={"floor": 6.5, "minimum_kwh": 3.0}),
                      buyer("A02", demand=2.5, max_price=6.8, budget=100.0)])
        self.assertEqual(result["baseline"]["trades"], [])
        self.assertEqual(events_of(result, "baseline", "offer_sent"), [])

    def test_bundle_counteroffer_below_minimum_is_rejected(self):
        result = run([seller("A01", max_offer=4.0, min_price=7.0,
                             conditional={"floor": 6.5, "minimum_kwh": 3.0}),
                      buyer("A02", demand=3.5, max_price=6.8, budget=15.0)])
        counters = events_of(result, "baseline", "counteroffer_sent")
        self.assertEqual(len(counters), 1)
        self.assertAlmostEqual(counters[0]["quantity_kwh"], 2.25)
        rejected = events_of(result, "baseline", "offer_rejected")
        self.assertEqual(rejected[-1]["reason_code"], "bundle_below_minimum")
        self.assertEqual(rejected[-1]["actor_id"], "A01")
        self.assertEqual(result["baseline"]["trades"], [])

    def test_conditional_floor_above_standard_floor_is_invalid(self):
        with self.assertRaises(ValueError):
            run([seller("A01", min_price=6.0, conditional={"floor": 6.5, "minimum_kwh": 2.0}),
                 buyer("A02")])

    def test_effective_floor_helper(self):
        s = seller("A01", min_price=7.0, conditional={"floor": 6.5, "minimum_kwh": 3.0})
        state = engine.agent_state(s)
        self.assertEqual(engine.effective_floor_paise(state, 2999), 700)
        self.assertEqual(engine.effective_floor_paise(state, 3000), 650)


class CapAndReplacementTests(unittest.TestCase):
    def test_utility_cap_limits_aggregate_reservations(self):
        result = run([seller("A01", max_offer=6.0), buyer("A02", demand=3.0, budget=100.0),
                      buyer("A04", demand=3.0, budget=100.0),
                      buyer("A06", demand=3.0, budget=100.0)],
                     utility_cap_kwh=4.0)
        base = result["baseline"]
        self.assertEqual(trades_of(result, "baseline"),
                         [("A01", "A02", 3.0, 6.5), ("A01", "A04", 1.0, 6.5)])
        self.assertAlmostEqual(base["metrics"]["committed_kwh"], 4.0)
        self.assertTrue(any(e["reason_code"] == "cap_exhausted" for e in base["events"]))
        self.assertEqual(engine.verify_result(result), [])

    def test_offer_to_full_counterparty_replaces_lower_surplus_trade_atomically(self):
        agents = [seller("A01", max_offer=2.0, min_price=6.0),
                  buyer("A02", demand=2.0, max_price=7.0, budget=100.0),
                  buyer("A04", demand=2.0, max_price=8.0, budget=100.0)]
        result = run(agents, {"agent_id": "A02", "scenario": "custom",
                              "changes": {"max_price": 9.0}})
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A04", 2.0, 7.0)])
        self.assertEqual(trades_of(result, "intervention"), [("A01", "A02", 2.0, 7.5)])
        replaced = events_of(result, "intervention", "offer_replaced")
        self.assertEqual(len(replaced), 1)
        self.assertEqual((replaced[0]["actor_id"], replaced[0]["counterparty_id"]), ("A01", "A02"))
        released = events_of(result, "intervention", "provisional_released")
        self.assertEqual(len(released), 1)
        self.assertEqual(released[0]["reason_code"], "displaced")
        self.assertEqual(released[0]["counterparty_id"], "A04")
        self.assertEqual(released[0]["transition_id"], replaced[0]["transition_id"])
        reserved = events_of(result, "intervention", "provisional_reserved")
        self.assertEqual(reserved[-1]["transition_id"], replaced[0]["transition_id"])
        self.assertIn(replaced[0]["id"], released[0]["caused_by"])
        group = [e for e in result["intervention"]["events"]
                 if e.get("transition_id") == replaced[0]["transition_id"]]
        self.assertEqual([e["type"] for e in group],
                         ["offer_replaced", "provisional_released", "provisional_reserved"])
        final = [t["id"] for t in reserved[-1]["trades_after"]]
        self.assertEqual(final, [result["intervention"]["trades"][0]["id"]])
        for event in group:
            self.assertEqual([t["id"] for t in event["trades_after"]], final)
        self.assertEqual([t["status"] for t in result["intervention"]["released_trades"]],
                         ["released"])
        comparison = result["comparison"]
        self.assertEqual(comparison["changed_trades"], 2)
        self.assertEqual(comparison["displaced_count"], 1)
        self.assertEqual(comparison["affected_agents"], ["A01", "A02", "A04"])
        self.assertEqual(comparison["direct_agents"], ["A01"])
        self.assertEqual(comparison["indirect_agents"], ["A04"])
        self.assertEqual(comparison["cascade_depth"], 1)
        self.assertEqual(engine.verify_result(result), [])


    def test_utility_before_and_after_cover_the_whole_transition(self):
        agents = [seller("A01", max_offer=2.0, min_price=6.0),
                  buyer("A02", demand=2.0, max_price=7.0, budget=100.0),
                  buyer("A04", demand=2.0, max_price=8.0, budget=100.0)]
        result = run(agents, {"agent_id": "A02", "scenario": "custom",
                              "changes": {"max_price": 9.0}})
        reserved = events_of(result, "intervention", "provisional_reserved")[-1]
        self.assertAlmostEqual(reserved["utility_before"]["A01"], 2.0)
        self.assertAlmostEqual(reserved["utility_after"]["A01"], 3.0)
        self.assertAlmostEqual(reserved["utility_before"]["A02"], 0.0)
        self.assertAlmostEqual(reserved["utility_after"]["A02"], 3.0)
        for event in events_of(result, "intervention"):
            for trade in event.get("trades_after", []):
                self.assertTrue(trade["created_event_id"])


class InterventionTests(unittest.TestCase):
    def pair(self):
        return [seller("A01", max_offer=4.0, min_price=6.0),
                buyer("A02", demand=3.0, max_price=7.0, budget=100.0)]

    def test_policy_change_revalidates_releases_and_renegotiates(self):
        result = run(self.pair(), {"agent_id": "A01", "scenario": "custom",
                                   "changes": {"min_price": 6.8}})
        self.assertEqual(trades_of(result, "baseline"), [("A01", "A02", 3.0, 6.5)])
        released = events_of(result, "intervention", "provisional_released")
        self.assertEqual(len(released), 1)
        self.assertEqual(released[0]["reason_code"], "price_below_floor")
        policy = events_of(result, "intervention", "policy_confirmed")
        self.assertEqual(len(policy), 1)
        self.assertIn(policy[0]["id"], released[0]["caused_by"])
        self.assertEqual(trades_of(result, "intervention"), [("A01", "A02", 3.0, 6.9)])
        self.assertAlmostEqual(result["intervention"]["trades"][0]["payment"], 20.7)
        comparison = result["comparison"]
        self.assertEqual(comparison["changed_trades"], 2)
        self.assertEqual(comparison["displaced_count"], 1)
        self.assertEqual(comparison["affected_agents"], ["A01", "A02"])
        self.assertEqual(comparison["direct_agents"], ["A02"])
        self.assertAlmostEqual(comparison["welfare_delta"], -2.4)
        self.assertEqual(comparison["cascade_depth"], 1)
        self.assertEqual(engine.verify_result(result), [])

    def test_no_op_change_reports_zero_changed_trades(self):
        result = run(self.pair(), {"agent_id": "A01", "scenario": "custom",
                                   "changes": {"min_price": 6.25}})
        self.assertEqual(trades_of(result, "intervention"), [("A01", "A02", 3.0, 6.5)])
        comparison = result["comparison"]
        self.assertEqual(comparison["changed_trades"], 0)
        self.assertEqual(comparison["displaced_count"], 0)
        self.assertEqual(comparison["affected_agents"], [])
        self.assertAlmostEqual(comparison["changed_kwh"], 0.0)
        self.assertEqual(result["intervention"]["status"], "locally_stable")
        self.assertEqual(result["manifest"]["changed_fields"],
                         [{"agent_id": "A01", "field": "min_price", "before": 6.0, "after": 6.25}])

    def test_revalidation_releases_all_invalid_trades_in_one_transition(self):
        agents = [seller("A01", max_offer=4.0, min_price=6.0),
                  buyer("A02", demand=2.0, max_price=7.0, budget=100.0),
                  buyer("A04", demand=2.0, max_price=7.0, budget=100.0)]
        result = run(agents, {"agent_id": "A01", "scenario": "custom",
                              "changes": {"min_price": 7.0}})
        self.assertEqual(trades_of(result, "baseline"),
                         [("A01", "A02", 2.0, 6.5), ("A01", "A04", 2.0, 6.5)])
        released = events_of(result, "intervention", "provisional_released")
        self.assertEqual(len(released), 2)
        self.assertEqual(len({e["transition_id"] for e in released}), 1)
        for event in released:
            self.assertEqual(event["trades_after"], [])
            self.assertEqual(event["reason_code"], "price_below_floor")
        self.assertEqual(result["intervention"]["trades"], [])
        self.assertEqual(result["comparison"]["changed_trades"], 2)
        self.assertEqual(result["comparison"]["displaced_count"], 2)
        self.assertEqual(engine.verify_result(result), [])

    def test_policy_update_invalidates_stale_rejections(self):
        agents = [seller("A01", max_offer=3.0, min_price=6.0,
                         conditional={"floor": 5.0, "minimum_kwh": 3.0}),
                  buyer("A02", demand=6.0, max_price=5.5, budget=15.0),
                  seller("A03", max_offer=3.0, min_price=4.0)]
        result = run(agents, {"agent_id": "A02", "scenario": "custom",
                              "changes": {"budget": 100.0}})
        self.assertEqual(trades_of(result, "baseline"), [("A03", "A02", 3.0, 4.75)])
        self.assertEqual(trades_of(result, "intervention"),
                         [("A03", "A02", 3.0, 4.75), ("A01", "A02", 3.0, 5.25)])
        self.assertEqual(result["intervention"]["status"], "locally_stable")
        self.assertEqual(engine.verify_result(result), [])

    def test_policy_repair_is_one_atomic_transition(self):
        agents = [seller("A01", max_offer=4.0, min_price=6.0),
                  buyer("A02", demand=2.0, max_price=7.0, budget=100.0),
                  buyer("A04", demand=2.0, max_price=7.0, budget=100.0)]
        result = run(agents, {"agent_id": "A01", "scenario": "custom",
                              "changes": {"max_offer_kwh": 0.0}})
        released = events_of(result, "intervention", "provisional_released")
        self.assertEqual(len(released), 2)
        self.assertEqual(len({e["transition_id"] for e in released}), 1)
        self.assertEqual([e["reason_code"] for e in released], ["over_supply", "over_supply"])
        for event in released:
            self.assertEqual(event["trades_after"], [])
        self.assertEqual(result["intervention"]["trades"], [])
        self.assertEqual(engine.verify_result(result), [])

    def test_direct_and_indirect_effects_use_intervention_origins(self):
        result = run([seller("A01", max_offer=2.0, min_price=6.0),
                      buyer("A02", demand=2.0, max_price=7.0, budget=100.0)],
                     {"agent_id": "A01", "scenario": "custom",
                      "changes": {"max_offer_kwh": 0.0}})
        comparison = result["comparison"]
        self.assertEqual(comparison["origin_agents"], ["A01"])
        self.assertEqual(comparison["affected_agents"], ["A01", "A02"])
        self.assertEqual(comparison["direct_agents"], ["A02"])
        self.assertEqual(comparison["indirect_agents"], [])
        self.assertEqual(comparison["messaged_agents"], [])
        shock = engine.run_experiment(config(population=20, seed=42),
                                      {"agent_id": "A17", "scenario": "shock"})
        origins = {c["agent_id"] for c in shock["manifest"]["changed_fields"]}
        self.assertEqual(set(shock["comparison"]["origin_agents"]), origins)
        self.assertFalse(origins & set(shock["comparison"]["indirect_agents"]))
        self.assertFalse(origins & set(shock["comparison"]["direct_agents"]))
        self.assertEqual(engine.verify_result(shock), [])

    def test_custom_change_with_unchanged_value_is_a_no_op(self):
        result = run(self.pair(), {"agent_id": "A01", "scenario": "custom",
                                   "changes": {"min_price": 6.0}})
        self.assertEqual(result["manifest"]["changed_fields"], [])
        self.assertEqual(result["comparison"]["changed_trades"], 0)
        self.assertEqual(result["intervention"]["status"], "locally_stable")

    def test_no_intervention_skips_second_run(self):
        result = run(self.pair())
        self.assertIsNone(result["intervention"])
        self.assertIsNone(result["comparison"])
        self.assertIsNone(result["updated_world"])
        result = run(self.pair(), {"agent_id": "A01", "scenario": "none"})
        self.assertIsNone(result["intervention"])

    def test_invalid_interventions_raise(self):
        cases = [
            {"agent_id": "A99", "scenario": "custom", "changes": {"min_price": 7.0}},
            {"agent_id": "A01", "scenario": "custom"},
            {"agent_id": "A01", "scenario": "custom", "changes": {"budget": 5.0}},
            {"agent_id": "A01", "scenario": "custom", "changes": {"min_price": 6.03}},
            {"agent_id": "A01", "scenario": "custom", "changes": {"min_price": -1.0}},
            {"agent_id": "A02", "scenario": "custom", "changes": {"budget": 10.005}},
            {"agent_id": "A01", "scenario": "wrong", "changes": {}},
        ]
        for intervention in cases:
            with self.subTest(intervention=intervention):
                with self.assertRaises(ValueError):
                    run(self.pair(), intervention)

    def test_memory_tie_break_records_provenance(self):
        memory = [{"id": "mem-1", "text": "Traded reliably with A04 last month.",
                   "preference": {"type": "preferred_counterparty", "agent_id": "A04"}}]
        agents = [seller("A01", max_offer=2.0, min_price=6.0, memory=memory),
                  buyer("A02", demand=2.0, max_price=7.0, budget=100.0),
                  buyer("A04", demand=2.0, max_price=7.0, budget=100.0)]
        with_memory = run(agents, memory_enabled=True)
        self.assertEqual(trades_of(with_memory, "baseline"), [("A01", "A04", 2.0, 6.5)])
        retrieved = events_of(with_memory, "baseline", "profile_retrieved")
        self.assertEqual(len(retrieved), 1)
        self.assertEqual(retrieved[0]["actor_id"], "A01")
        self.assertEqual(retrieved[0]["memory_ids"], ["mem-1"])
        without = run(agents, memory_enabled=False)
        self.assertEqual(trades_of(without, "baseline"), [("A01", "A02", 2.0, 6.5)])
        self.assertEqual(events_of(without, "baseline", "profile_retrieved"), [])


class GeneratedWorldTests(unittest.TestCase):
    def test_world_generation_follows_contract(self):
        cfg = config(population=50, seed=42, topology="local")
        world = engine.build_world(cfg)
        agents = world["agents"]
        self.assertEqual([a["id"] for a in agents], [f"A{i:02d}" for i in range(1, 51)])
        for a in agents:
            number = int(a["id"][1:])
            self.assertEqual(a["role"], "seller" if number % 2 else "buyer")
            for key in ("name", "context", "interval_start", "interval_end", "timezone",
                        "deadline_round", "memory"):
                self.assertIn(key, a)
            self.assertEqual(a["interval_start"], INTERVAL["interval_start"])
            self.assertEqual(a["timezone"], "Asia/Kolkata")
            if a["role"] == "seller":
                self.assertLessEqual(a["max_offer_kwh"],
                                     a["forecast_surplus_kwh"] - a["reserve_kwh"] + 1e-9)
                self.assertEqual(round(a["min_price"] * 100) % 5, 0)
                if a["conditional_price"]:
                    self.assertLess(a["conditional_price"]["floor"], a["min_price"])
            else:
                self.assertAlmostEqual(a["budget"] * 100, round(a["budget"] * 100), places=6)
                self.assertEqual(round(a["max_price"] * 100) % 5, 0)
        a17 = next(a for a in agents if a["id"] == "A17")
        self.assertEqual(a17["role"], "seller")
        self.assertEqual(a17["max_offer_kwh"], 4.0)
        self.assertEqual(a17["min_price"], 6.5)
        self.assertIsNone(a17["conditional_price"])
        roles = {a["id"]: a["role"] for a in agents}
        degree = {a["id"]: 0 for a in agents}
        for a, b in world["discovery_edges"]:
            self.assertLess(a, b)
            self.assertNotEqual(roles[a], roles[b])
            degree[a] += 1
            degree[b] += 1
        self.assertTrue(all(1 <= d <= 12 for d in degree.values()))
        open_world = engine.build_world(config(population=50, topology="open"))
        self.assertEqual(len(open_world["discovery_edges"]), 25 * 25)
        self.assertEqual(sorted(world["private_fields"]),
                         ["budget", "conditional_price", "context", "forecast_surplus_kwh",
                          "memory", "reserve_kwh"])

    def test_different_seed_gives_different_world(self):
        a = engine.build_world(config(population=20, seed=42))
        b = engine.build_world(config(population=20, seed=7))
        self.assertNotEqual(a["agents"], b["agents"])

    def test_same_inputs_give_same_outputs(self):
        cfg = config(population=20, seed=42, topology="local")
        intervention = {"agent_id": "A17", "scenario": "price"}
        first = engine.run_experiment(cfg, intervention)
        second = engine.run_experiment(cfg, intervention)
        self.assertEqual(engine.strip_runtime(first), engine.strip_runtime(second))
        self.assertEqual(first["manifest"]["checksums"], second["manifest"]["checksums"])
        self.assertTrue(first["manifest"]["checksums"]["baseline_events"].startswith("sha256:"))

    def test_inputs_are_not_mutated(self):
        cfg = config(population=20, seed=42)
        intervention = {"agent_id": "A17", "scenario": "custom",
                        "changes": {"min_price": 7.0,
                                    "conditional_price": {"floor": 6.5, "minimum_kwh": 3.0}}}
        world = engine.build_world(cfg)
        before = json.dumps([cfg, intervention, world], sort_keys=True)
        result = engine.run_experiment(cfg, intervention, world=world)
        self.assertEqual(json.dumps([cfg, intervention, world], sort_keys=True), before)
        self.assertEqual(result["world"], world)
        self.assertIsNot(result["updated_world"], result["world"])
        a17 = next(a for a in result["updated_world"]["agents"] if a["id"] == "A17")
        self.assertEqual(a17["min_price"], 7.0)
        self.assertEqual(a17["conditional_price"], {"floor": 6.5, "minimum_kwh": 3.0})
        original = next(a for a in result["world"]["agents"] if a["id"] == "A17")
        self.assertEqual(original["min_price"], 6.5)

    def test_manifest_lists_exact_changed_fields_and_scope(self):
        cfg = config(population=20, seed=42)
        result = engine.run_experiment(cfg, {"agent_id": "A17", "scenario": "price"})
        manifest = result["manifest"]
        self.assertEqual(manifest["protocol_version"], engine.PROTOCOL_VERSION)
        self.assertEqual(manifest["changed_fields"],
                         [{"agent_id": "A17", "field": "min_price", "before": 6.5, "after": 7.0}])
        for key in ("price_rule", "utility_formula", "admissible_moves", "stability_scope"):
            self.assertTrue(manifest[key])
        self.assertEqual(manifest["config"], cfg)

    def test_shock_scenario_changes_many_sellers(self):
        cfg = config(population=20, seed=42)
        result = engine.run_experiment(cfg, {"agent_id": "A17", "scenario": "shock"})
        changed = result["manifest"]["changed_fields"]
        ids = {c["agent_id"] for c in changed}
        self.assertGreaterEqual(len(ids), 2)
        self.assertTrue(all(int(i[1:]) % 2 for i in ids))
        self.assertTrue(all(c["field"] == "forecast_surplus_kwh" for c in changed))

    def test_invariants_hold_at_every_population(self):
        for population in (20, 50, 100):
            for topology in ("local", "open"):
                with self.subTest(population=population, topology=topology):
                    cfg = config(population=population, topology=topology)
                    result = engine.run_experiment(cfg, {"agent_id": "A17", "scenario": "price"})
                    self.assertEqual(engine.verify_result(result), [])
                    for name in ("baseline", "intervention"):
                        run_result = result[name]
                        self.assertIn(run_result["status"], engine.STATUSES)
                        self.assertTrue(run_result["stability_scope"])
                        self.assertEqual(run_result["metrics"]["hard_constraint_violations"], 0)
                        self.assertEqual(run_result["messages"], run_result["metrics"]["message_count"])
                        self.assertLessEqual(run_result["rounds"], cfg["max_rounds"])

    def test_callers_can_choose_more_rounds_for_the_open_hundred_agent_market(self):
        default = engine.run_experiment(config(population=100, topology="open"),
                                        {"agent_id": "A17", "scenario": "price"})
        self.assertEqual(default["baseline"]["status"], "round_limited")
        self.assertEqual(default["baseline"]["rounds"], 12)
        self.assertIn("caveat", default["comparison"])
        longer = engine.run_experiment(config(population=100, topology="open", max_rounds=20),
                                       {"agent_id": "A17", "scenario": "price"})
        self.assertEqual(longer["baseline"]["status"], "locally_stable")
        self.assertNotIn("caveat", longer["comparison"])
        self.assertEqual(engine.verify_result(longer), [])

    def test_private_fields_never_appear_in_events(self):
        cfg = config(population=20, topology="open")
        result = engine.run_experiment(cfg, {"agent_id": "A17", "scenario": "price"})
        dump = json.dumps(result["baseline"]["events"] + result["intervention"]["events"])
        for agent in result["world"]["agents"]:
            self.assertNotIn(agent["context"], dump)
            for record in agent["memory"]:
                self.assertNotIn(record["text"], dump)
        for key in result["world"]["private_fields"]:
            self.assertNotIn(f'"{key}"', dump)

    def test_round_limit_reports_honest_status(self):
        cfg = config(population=20, max_rounds=1)
        result = engine.run_experiment(cfg)
        base = result["baseline"]
        self.assertEqual(base["status"], "round_limited")
        self.assertEqual(base["termination_reason"], "max_rounds")
        self.assertIn("not exhausted", base["stability_scope"])
        self.assertTrue(base["trades"])
        self.assertTrue(all(t["status"] == "committed" for t in base["trades"]))
        self.assertEqual(engine.verify_result(result), [])

    def test_round_limit_applies_to_both_runs_and_flags_caveat(self):
        cfg = config(population=50, topology="open", max_rounds=1)
        result = engine.run_experiment(cfg, {"agent_id": "A17", "scenario": "price"})
        self.assertEqual(result["baseline"]["status"], "round_limited")
        self.assertEqual(result["intervention"]["status"], "round_limited")
        self.assertEqual(result["intervention"]["rounds"], 1)
        self.assertIn("caveat", result["comparison"])
        with self.assertRaises(ValueError):
            engine.run_experiment(config(population=20, baseline_max_rounds=1))

    def test_message_cap_is_enforced_before_every_message(self):
        for cap in (0, 1, 2, 3, 5):
            with self.subTest(cap=cap):
                result = engine.run_experiment(config(population=20, max_messages=cap))
                base = result["baseline"]
                self.assertLessEqual(base["messages"], cap)
                self.assertEqual(sum(e["type"] in engine.MESSAGE_TYPES for e in base["events"]),
                                 base["messages"])
                self.assertEqual(base["status"], "round_limited")
                self.assertEqual(base["termination_reason"], "max_messages")
                self.assertEqual(engine.verify_result(result), [])

    def test_message_cap_holds_for_the_http_fixture(self):
        result = engine.run_experiment({"population": 20, "seed": 4, "max_messages": 10})
        base = result["baseline"]
        self.assertLessEqual(base["messages"], 10)
        self.assertEqual(sum(e["type"] in engine.MESSAGE_TYPES for e in base["events"]),
                         base["messages"])
        self.assertEqual(base["termination_reason"], "max_messages")
        self.assertEqual(engine.verify_result(result), [])
        pair = run([seller("A01", max_offer=4.0, min_price=6.0),
                    buyer("A02", demand=4.0, max_price=7.0, budget=13.0)], max_messages=1)
        self.assertEqual(pair["baseline"]["messages"], 1)
        self.assertEqual(pair["baseline"]["trades"], [])
        self.assertEqual(pair["baseline"]["status"], "round_limited")

    def test_verify_result_checks_every_snapshot(self):
        result = run([seller("A01", max_offer=4.0), buyer("A02", demand=2.0),
                      buyer("A04", demand=2.0)])
        self.assertEqual(engine.verify_result(result), [])
        bad = copy.deepcopy(result)
        for event in bad["baseline"]["events"]:
            if event["type"] == "provisional_reserved":
                event["trades_after"][0]["quantity_kwh"] = 9999
                break
        self.assertTrue(engine.verify_result(bad))
        bad = copy.deepcopy(result)
        reserved = [e for e in bad["baseline"]["events"] if e["type"] == "provisional_reserved"]
        reserved[0]["trades_after"] = []
        self.assertTrue(engine.verify_result(bad))

    def test_every_atomic_snapshot_preserves_payment_and_provenance(self):
        result = run([seller('A01', max_offer=2, min_price=6),
                      buyer('A02', demand=2, max_price=7),
                      buyer('A04', demand=2, max_price=8)],
                     {'agent_id': 'A02', 'scenario': 'custom', 'changes': {'max_price': 9}})
        for field, value in [('payment', 9999), ('created_event_id', 'missing'),
                             ('status', 'settled')]:
            with self.subTest(field=field):
                bad = copy.deepcopy(result)
                release = next(e for e in bad['intervention']['events']
                               if e['type'] == 'provisional_released')
                release['trades_after'][0][field] = value
                self.assertTrue(engine.verify_result(bad))

    def test_message_limit_reports_honest_status(self):
        cfg = config(population=20, max_messages=3)
        result = engine.run_experiment(cfg)
        base = result["baseline"]
        self.assertEqual(base["status"], "round_limited")
        self.assertEqual(base["termination_reason"], "max_messages")
        self.assertLessEqual(base["messages"], 3)

    def test_events_end_with_check_commit_and_terminate(self):
        result = engine.run_experiment(config(population=20))
        types = [e["type"] for e in result["baseline"]["events"]]
        self.assertEqual(types[0], "world_generated")
        self.assertEqual(types[-3:], ["stability_checked", "commitment_finalized", "terminated"])
        sequences = [e["sequence"] for e in result["baseline"]["events"]]
        self.assertEqual(sequences, list(range(1, len(sequences) + 1)))

    def test_verify_result_catches_tampering(self):
        result = engine.run_experiment(config(population=20))
        tampered = copy.deepcopy(result)
        tampered["baseline"]["trades"][0]["quantity_kwh"] += 100.0
        self.assertTrue(engine.verify_result(tampered))
        tampered = copy.deepcopy(result)
        tampered["baseline"]["events"][5]["caused_by"] = ["ev-9999"]
        self.assertTrue(engine.verify_result(tampered))


if __name__ == "__main__":
    unittest.main()
