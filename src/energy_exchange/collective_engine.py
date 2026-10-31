"""Deterministic collective negotiation engine for the energy sandbox.

Pure Python, no dependencies. Energy is kept in whole watt hours, money in
whole paise, and utility in paise times watt hours, so every rule is
integer arithmetic and the same inputs always give the same trace.

The protocol is bounded bilateral improvement. Each queued agent ranks its
candidate proposals by expected gain, sends at most a few offers, and the
first acceptance changes the provisional allocation in one atomic
transition. A run ends locally stable only when a final sweep over every
agent finds no admissible proposal left. See work/claude-engine-review.md
for the rules and their defaults.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import random
import statistics
import time
from datetime import timedelta

from .collective_time import validate_interval, contains, parse_time, segments

from .collective_bargaining import (default_strategy_plan, validate_strategy_plan, quote_price)

PROTOCOL_VERSION = "collective-bilateral-v2"
ENGINE_VERSION = "0.2.1"
CHECKSUM_VERSION = "canonical-json-numbers-v2"
LEGACY_CHECKSUM_VERSION = "python-json-v1"
STATUSES = ("locally_stable", "round_limited", "cycle_detected", "unresolved")
SCENARIOS = ("custom", "price", "supply", "budget", "shock", "none")
TOPOLOGIES = ("local", "open")

INTERVAL_START = "2026-10-28T14:00:00+05:30"
INTERVAL_END = "2026-10-28T16:00:00+05:30"
TIMEZONE = "Asia/Kolkata"

ENERGY_TICK_WH = 10
EPSILON_RAW = 1000  # one paise, in paise times watt hours per kWh units
RAW_PER_INR = 100_000

PRIVATE_FIELDS = ["budget", "conditional_price", "context",
                  "forecast_surplus_kwh", "memory", "reserve_kwh"]
MESSAGE_TYPES = ("offer_sent", "counteroffer_sent", "offer_rejected", "offer_accepted")
RESERVATION_TYPES = ("provisional_reserved", "provisional_released",
                     "offer_replaced")
SELLER_CHANGES = {"min_price", "max_offer_kwh", "forecast_surplus_kwh",
                  "reserve_kwh", "conditional_price", "deadline_round",
                  "interval_start", "interval_end", "time_price"}
BUYER_CHANGES = {"demand_kwh", "max_price", "budget", "deadline_round",
                 "interval_start", "interval_end"}
CONFIG_KEYS = {"population", "seed", "topology", "max_rounds", "max_messages",
               "utility_cap_kwh", "memory_enabled", "price_tick",
               "local_degree", "max_offers_per_turn", "negotiation_mode"}

PRICE_RULE = ("midpoint of the seller's effective floor and the buyer's maximum,"
              " rounded half up to the price tick and clamped into that band;"
              " payment rounded half up to whole paise")
UTILITY_FORMULA = ("surplus_v1: seller utility = sum over its trades of"
                   " (price - effective floor) x quantity; buyer utility = sum of"
                   " (maximum price - price) x quantity; no shortfall or missed"
                   " requirement penalty; welfare = sum of both, so transfers cancel")
ADMISSIBLE_MOVES = ("fill within free capacity; replacement of one of the mover's own"
                    " trades; acceptance by releasing one of the responder's own"
                    " trades; one provisional trade per seller and buyer pair; the"
                    " mover gains at least 1 paise; a responder that releases a trade"
                    " gains at least 1 paise; no coalition or multi trade moves")
STABILITY_SCOPE_STABLE = (
    "locally stable: a final sweep over every agent in id order found no proposal"
    " (fill or single trade replacement among discovery neighbors under the recorded"
    " pricing strategy and bounded move set)"
    " with expected mover gain of at least 1 paise that the counterparty had not"
    " already rejected in its unchanged state. Not a Nash or competitive equilibrium"
    " claim.")
STABILITY_SCOPE_LIMITED = (
    "search not exhausted: the run stopped on a configured limit before the final"
    " sweep could confirm that no admissible proposal remained. Do not read the"
    " allocation as stable.")
STABILITY_SCOPE_CYCLE = (
    "cycle detected: the provisional allocation repeated a previous state, so the"
    " protocol halted under its documented recovery rule (halt). The search was not"
    " exhausted.")
STABILITY_SCOPE_UNRESOLVED = (
    "unresolved: the final allocation failed an invariant check, so nothing was"
    " committed.")

FIRST_NAMES = ["Asha", "Ravi", "Meera", "Kiran", "Nilesh", "Priya", "Sunil",
               "Deepa", "Farhan", "Lata", "Manoj", "Rekha", "Tanvi", "Vikram",
               "Zoya", "Harish", "Pooja", "Omkar", "Sana", "Yash"]
LOCALITIES = ["Andheri", "Bandra", "Borivali", "Chembur", "Dadar", "Ghatkopar",
              "Goregaon", "Kandivali", "Malad", "Mulund"]
HOMES = ["two bedroom flat", "three bedroom flat", "row house", "one bedroom flat",
         "ground floor shop with living quarters"]
SELLER_HABITS = ["usually away during the afternoon", "runs a home office",
                 "charges a two wheeler overnight", "keeps a small battery for outages",
                 "shares the roof with a neighbor"]
BUYER_HABITS = ["runs air conditioning after 2 PM", "works from home",
                "has an electric water heater", "cooks on an induction stove",
                "charges a scooter in the afternoon"]


# -- units and rules ----------------------------------------------------------


def _finite(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} must be a finite nonnegative number")
    return value


def to_wh(kwh, label):
    _finite(kwh, label)
    wh = round(kwh * 1000)
    if abs(kwh * 1000 - wh) > 1e-6:
        raise ValueError(f"{label} must be a whole number of watt hours")
    return int(wh)


def to_paise(inr, label):
    _finite(inr, label)
    paise = round(inr * 100)
    if abs(inr * 100 - paise) > 1e-6:
        raise ValueError(f"{label} must be a whole number of paise")
    return int(paise)


def kwh(wh):
    return wh / 1000


def inr(paise):
    return paise / 100


def raw_inr(raw):
    return round(raw / RAW_PER_INR, 5)


def price_paise(floor, maximum, tick):
    """Midpoint rounded half up to the tick, clamped into [floor, maximum]."""
    if floor > maximum:
        return None
    price = tick * ((floor + maximum + tick) // (2 * tick))
    return max(floor, min(maximum, price))


def payment_paise(wh, paise):
    return (wh * paise + 500) // 1000


def affordable_wh(budget_paise, price):
    if price <= 0:
        return 10 ** 9
    wh = (budget_paise * 1000) // price
    wh -= wh % ENERGY_TICK_WH
    while wh > 0 and payment_paise(wh, price) > budget_paise:
        wh -= ENERGY_TICK_WH
    return max(0, wh)


def _canonical_numbers(obj):
    """JSON numbers retain their value when browsers remove .0 or negative zero."""
    if isinstance(obj, float) and math.isfinite(obj) and obj.is_integer():
        return int(obj)
    if isinstance(obj, dict):
        return {key: _canonical_numbers(value) for key, value in obj.items()}
    if isinstance(obj, (tuple, list)):
        return [_canonical_numbers(value) for value in obj]
    return obj


def canonical_json(obj):
    return json.dumps(_canonical_numbers(obj), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False)


def fingerprint(obj, version=CHECKSUM_VERSION):
    if version == CHECKSUM_VERSION:
        serialized = canonical_json(obj)
    elif version == LEGACY_CHECKSUM_VERSION:
        serialized = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    else:
        raise ValueError(f"unsupported checksum version: {version}")
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def state_hash(trades):
    rows = sorted((t["seller_id"], t["buyer_id"], t["wh"], t["paise"], bool(t["bundle"]),
                   t.get("delivery_start"), t.get("delivery_end"))
                  for t in trades)
    return fingerprint(rows)


def default_config():
    return {
        "population": 50, "seed": 42, "topology": "local", "max_rounds": 12,
        "max_messages": 4000, "utility_cap_kwh": 400.0, "memory_enabled": True,
        "price_tick": 0.05, "local_degree": 6, "max_offers_per_turn": 8,
        "negotiation_mode": "midpoint",
    }


def _validate_config(config):
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    unknown = sorted(set(config) - CONFIG_KEYS)
    if unknown:
        raise ValueError(f"unknown config fields: {unknown}")
    cfg = default_config()
    cfg.update(config)
    if cfg["population"] not in (20, 50, 100) and not (
            isinstance(cfg["population"], int) and 2 <= cfg["population"] <= 100):
        raise ValueError("population must be 20, 50 or 100")
    if not isinstance(cfg["seed"], int) or isinstance(cfg["seed"], bool):
        raise ValueError("seed must be an integer")
    if cfg["topology"] not in TOPOLOGIES:
        raise ValueError("topology must be local or open")
    for key in ("max_rounds", "max_messages", "local_degree", "max_offers_per_turn"):
        if not isinstance(cfg[key], int) or isinstance(cfg[key], bool) or cfg[key] < 0:
            raise ValueError(f"{key} must be a nonnegative integer")
    if not isinstance(cfg["memory_enabled"], bool):
        raise ValueError("memory_enabled must be true or false")
    if cfg["negotiation_mode"] not in ("midpoint", "bargaining"):
        raise ValueError("negotiation_mode must be midpoint or bargaining")
    tick = to_paise(cfg["price_tick"], "price_tick")
    if tick < 1:
        raise ValueError("price_tick must be at least one paise")
    cap_wh = to_wh(cfg["utility_cap_kwh"], "utility_cap_kwh")
    return cfg, tick, cap_wh


# -- agents and worlds -------------------------------------------------------


def make_agent(agent_id, role, **fields):
    if role not in ("seller", "buyer"):
        raise ValueError("role must be seller or buyer")
    agent = {
        "id": agent_id, "name": f"Household {agent_id}", "role": role,
        "context": "Synthetic household.",
        "interval_start": INTERVAL_START, "interval_end": INTERVAL_END,
        "timezone": TIMEZONE,
        "forecast_surplus_kwh": None, "reserve_kwh": None, "max_offer_kwh": None,
        "min_price": None, "conditional_price": None, "time_price": None,
        "demand_kwh": None, "max_price": None, "budget": None,
        "deadline_round": None, "memory": [],
    }
    unknown = sorted(set(fields) - set(agent))
    if unknown:
        raise ValueError(f"unknown agent fields: {unknown}")
    agent.update(fields)
    return agent


def _agent_rng(seed, index):
    return random.Random(seed * 1000 + index)


def _generate_agent(seed, index, population):
    rng = _agent_rng(seed, index)
    agent_id = f"A{index:02d}"
    role = "seller" if index % 2 else "buyer"
    name = f"{FIRST_NAMES[rng.randrange(len(FIRST_NAMES))]} ({LOCALITIES[rng.randrange(len(LOCALITIES))]})"
    home = HOMES[rng.randrange(len(HOMES))]
    fields = {"name": name}
    if role == "seller":
        forecast = rng.randrange(30, 81) / 10
        reserve = rng.randrange(5, 21) / 10
        max_offer = min(math.floor((forecast - reserve) * 10) / 10,
                        rng.choice([2.0, 3.0, 4.0, 5.0, 6.0]))
        max_offer = max(0.5, max_offer)
        min_price = 5.5 + 0.25 * rng.randrange(0, 9)
        conditional = None
        if max_offer >= 2.0 and rng.random() < 0.35:
            conditional = {"floor": round(min_price - 0.25 * rng.randrange(1, 4), 2),
                           "minimum_kwh": min(max_offer, rng.choice([2.0, 2.5, 3.0]))}
        kw = rng.choice([2, 3, 4, 5])
        fields.update(
            context=f"{home.capitalize()} in {name.split('(')[1][:-1]} with a {kw} kW"
                    f" rooftop solar system; {rng.choice(SELLER_HABITS)}.",
            forecast_surplus_kwh=round(forecast, 1), reserve_kwh=round(reserve, 1),
            max_offer_kwh=round(max_offer, 1), min_price=round(min_price, 2),
            conditional_price=conditional,
            deadline_round=rng.choice([None, None, None, 8, 10, 12]))
    else:
        demand = rng.randrange(10, 61, 5) / 10
        max_price = 6.25 + 0.25 * rng.randrange(0, 12)
        budget = int(demand * max_price * rng.choice([0.7, 0.85, 1.0, 1.15]) * 100 + 0.5) / 100
        fields.update(
            context=f"{home.capitalize()} in {name.split('(')[1][:-1]};"
                    f" {rng.choice(BUYER_HABITS)}.",
            demand_kwh=round(demand, 1), max_price=round(max_price, 2),
            budget=round(budget, 2),
            deadline_round=rng.choice([None, None, 6, 9, 12]))
    memory = []
    count = rng.randrange(1, 4)
    for n in range(count):
        kind = rng.choice(["preferred_counterparty", "price_anchor", "reliability"])
        record_id = f"mem-{agent_id}-{n + 1}"
        if kind == "preferred_counterparty":
            others = [j for j in range(1, population + 1) if (j % 2) != (index % 2)]
            partner = f"A{rng.choice(others):02d}"
            memory.append({"id": record_id,
                           "text": f"Traded with {partner} last month without a dispute.",
                           "preference": {"type": "preferred_counterparty",
                                          "agent_id": partner}})
        elif kind == "price_anchor":
            anchor = 5.5 + 0.25 * rng.randrange(0, 14)
            memory.append({"id": record_id,
                           "text": f"Last month's typical price was INR {anchor:.2f}/kWh.",
                           "preference": {"type": "price_anchor", "value": round(anchor, 2)}})
        else:
            memory.append({"id": record_id,
                           "text": "Prefers counterparties that settled on time before.",
                           "preference": {"type": "note"}})
    fields["memory"] = memory
    if agent_id == "A17":
        fields.update(forecast_surplus_kwh=6.0, reserve_kwh=2.0, max_offer_kwh=4.0,
                      min_price=6.5, conditional_price=None)
    return make_agent(agent_id, role, **fields)


def _discovery_edges(agents, topology, degree):
    ids = [a["id"] for a in agents]
    roles = {a["id"]: a["role"] for a in agents}
    n = len(ids)
    edges = set()
    for i, me in enumerate(ids):
        others = [(min(abs(i - j), n - abs(i - j)), other)
                  for j, other in enumerate(ids) if roles[other] != roles[me]]
        others.sort()
        chosen = others if topology == "open" else others[:degree]
        for _, other in chosen:
            edges.add(tuple(sorted((me, other))))
    return [list(e) for e in sorted(edges)]


def make_world(agents, config):
    cfg, _tick, _cap = _validate_config(config)
    agents = copy.deepcopy(list(agents))
    ids = [a["id"] for a in agents]
    if len(set(ids)) != len(ids):
        raise ValueError("agent ids must be unique")
    for agent in agents:
        agent_state(agent, _tick)
    world_config = dict(cfg)
    world_config["population"] = len(agents)
    return {
        "agents": agents,
        "discovery_edges": _discovery_edges(agents, cfg["topology"], cfg["local_degree"]),
        "config": world_config,
        "interval": {
            "start": min((parse_time(a["interval_start"]) for a in agents), default=parse_time(INTERVAL_START)).isoformat(),
            "end": max((parse_time(a["interval_end"]) for a in agents), default=parse_time(INTERVAL_END)).isoformat(),
            "timezone": TIMEZONE},
        "private_fields": list(PRIVATE_FIELDS),
    }


def build_world(config):
    cfg, _tick, _cap = _validate_config(config)
    population = cfg["population"]
    agents = [_generate_agent(cfg["seed"], i, population) for i in range(1, population + 1)]
    if cfg["negotiation_mode"] == "bargaining":
        # Delivery preferences are synthetic and independent of generation RNG.
        # A17 remains the familiar baseline household used by existing examples.
        for i, agent in enumerate(agents, 1):
            if agent["id"] == "A17":
                continue
            hour = 20 if i % 5 == 0 else 15 if i % 5 == 1 else 14
            start = parse_time(INTERVAL_START).replace(hour=hour)
            agent["interval_start"] = start.isoformat()
            agent["interval_end"] = (start + timedelta(hours=2)).isoformat()
            if agent["role"] == "seller" and i % 3 == 0:
                floor = max(0, ((to_paise(agent["min_price"], "min_price") - 50) // _tick) * _tick)
                agent["time_price"] = {"after": (start + timedelta(hours=1)).isoformat(),
                                       "floor": inr(floor)}
            agent["context"] += " Energy is freely shiftable within its delivery window, subject to one total household pool."
    return make_world(agents, cfg)


def agent_state(agent, tick=5):
    """Integer form of a profile, validated against the hard constraint rules."""
    role = agent["role"]
    label = agent["id"]
    state = {"id": label, "role": role, "version": 0,
             "interval": validate_interval(agent["interval_start"], agent["interval_end"]),
             "deadline": agent.get("deadline_round"),
             "preferred": [], "memory_ids": {}}
    if not isinstance(state["interval"][0], str) or not isinstance(state["interval"][1], str):
        raise ValueError(f"{label}: interval bounds must be strings")
    deadline = state["deadline"]
    if deadline is not None and (isinstance(deadline, bool) or not isinstance(deadline, int)
                                 or deadline < 0):
        raise ValueError(f"{label}: deadline_round must be a nonnegative integer or null")
    for record in agent.get("memory") or []:
        pref = record.get("preference") or {}
        if pref.get("type") == "preferred_counterparty":
            state["preferred"].append(pref["agent_id"])
            state["memory_ids"][pref["agent_id"]] = record["id"]
    if role == "seller":
        forecast = to_wh(agent["forecast_surplus_kwh"], f"{label}.forecast_surplus_kwh")
        reserve = to_wh(agent["reserve_kwh"], f"{label}.reserve_kwh")
        max_offer = to_wh(agent["max_offer_kwh"], f"{label}.max_offer_kwh")
        floor = to_paise(agent["min_price"], f"{label}.min_price")
        if floor % tick:
            raise ValueError(f"{label}: min_price must be on the price tick")
        timed = agent.get("time_price")
        if timed is not None:
            if not isinstance(timed, dict) or set(timed) != {"after", "floor"}:
                raise ValueError(f"{label}: time_price needs after and floor")
            after = parse_time(timed["after"])
            timed_floor = to_paise(timed["floor"], f"{label}.time_price.floor")
            if timed_floor % tick or timed_floor >= floor:
                raise ValueError(f"{label}: time price must be on tick and below the ordinary floor")
            if not parse_time(state["interval"][0]) <= after < parse_time(state["interval"][1]):
                raise ValueError(f"{label}: time price must start within the delivery window")
            timed = (after.isoformat(), timed_floor)
        state["time_price"] = timed
        cond = agent.get("conditional_price")
        if cond is not None:
            if not isinstance(cond, dict) or set(cond) != {"floor", "minimum_kwh"}:
                raise ValueError(f"{label}: conditional_price needs floor and minimum_kwh")
            cond_floor = to_paise(cond["floor"], f"{label}.conditional_price.floor")
            cond_min = to_wh(cond["minimum_kwh"], f"{label}.conditional_price.minimum_kwh")
            if cond_floor % tick:
                raise ValueError(f"{label}: conditional floor must be on the price tick")
            if cond_floor >= floor:
                raise ValueError(f"{label}: conditional floor must be below min_price")
            if cond_min <= 0:
                raise ValueError(f"{label}: conditional minimum_kwh must be positive")
            cond = (cond_floor, cond_min)
        state.update(offer_wh=max(0, min(max_offer, forecast - reserve)), floor=floor,
                     cond=cond)
    else:
        if agent.get("time_price") is not None:
            raise ValueError(f"{label}: time_price is available only for sellers")
        demand = to_wh(agent["demand_kwh"], f"{label}.demand_kwh")
        maximum = to_paise(agent["max_price"], f"{label}.max_price")
        if maximum % tick:
            raise ValueError(f"{label}: max_price must be on the price tick")
        budget = to_paise(agent["budget"], f"{label}.budget")
        state.update(demand_wh=demand, maximum=maximum, budget=budget)
    return state


def effective_floor_paise(state, wh, delivery_start=None):
    floor = state["floor"]
    timed = state.get("time_price")
    if timed and delivery_start and parse_time(delivery_start) >= parse_time(timed[0]):
        floor = min(floor, timed[1])
    cond = state.get("cond")
    if cond and wh >= cond[1]:
        floor = min(floor, cond[0])
    return floor


# -- engine state ------------------------------------------------------------


class _Run:
    """Mutable negotiation state for one run (baseline or intervention)."""

    def __init__(self, world, cfg, tick, cap_wh, name, strategy_plan=None,
                 checksum_version=CHECKSUM_VERSION):
        self.plan = strategy_plan or default_strategy_plan(world["agents"])
        self.plan_hash = fingerprint(self.plan, checksum_version)
        self.name = name
        self.prefix = "ev-" if name == "baseline" else "iv-"
        self.cfg = cfg
        self.max_rounds = cfg["max_rounds"]
        self.tick = tick
        self.cap_total = cap_wh
        self.agents = {a["id"]: agent_state(a, tick) for a in world["agents"]}
        self.neighbors = {aid: [] for aid in self.agents}
        for a, b in world["discovery_edges"]:
            self.neighbors[a].append(b)
            self.neighbors[b].append(a)
        for aid in self.neighbors:
            self.neighbors[aid].sort()
        self.trades = {}
        self.released = []
        self.next_trade = 1
        self.rejections = {}
        self.events = []
        self.by_id = {}
        self.sequence = 0
        self.transition = 0
        self.messages = 0
        self.limit_hit = False
        self.round = 0
        self.queue = []
        self.queued_by = {}
        self.hashes = set()
        self.status = None
        self.termination_reason = None
        self.last_decision = {aid: "" for aid in self.agents}
        self.sent = {aid: 0 for aid in self.agents}
        self.hop = {}
        self.tail = None

    # -- bookkeeping --

    def clone_for(self, name):
        other = copy.copy(self)
        other.name = name
        other.prefix = "ev-" if name == "baseline" else "iv-"
        other.agents = copy.deepcopy(self.agents)
        other.neighbors = self.neighbors
        other.trades = copy.deepcopy(self.trades)
        other.released = []
        other.rejections = dict(self.rejections)
        other.events = []
        other.by_id = {}
        other.sequence = 0
        other.transition = 0
        other.messages = 0
        other.limit_hit = False
        other.round = 0
        other.queue = []
        other.queued_by = {}
        other.hashes = set()
        other.status = None
        other.termination_reason = None
        other.last_decision = {aid: "" for aid in self.agents}
        other.sent = {aid: 0 for aid in self.agents}
        other.hop = {}
        other.tail = None
        return other

    @property
    def reserved_cap(self):
        return sum(t["wh"] for t in self.trades.values())

    @property
    def cap_free(self):
        return self.cap_total - self.reserved_cap

    def trades_of(self, aid):
        key = "seller_id" if self.agents[aid]["role"] == "seller" else "buyer_id"
        return sorted((t for t in self.trades.values() if t[key] == aid), key=lambda t: t["id"])

    def reserved_wh(self, aid):
        return sum(t["wh"] for t in self.trades_of(aid))

    def spent(self, aid):
        return sum(t["payment"] for t in self.trades_of(aid))

    def free_wh(self, aid):
        a = self.agents[aid]
        total = a["offer_wh"] if a["role"] == "seller" else a["demand_wh"]
        return max(0, total - self.reserved_wh(aid))

    def free_budget(self, aid):
        return self.agents[aid]["budget"] - self.spent(aid)

    def surplus(self, aid, wh, price, delivery_start=None):
        a = self.agents[aid]
        if a["role"] == "seller":
            return (price - effective_floor_paise(a, wh, delivery_start)) * wh
        return (a["maximum"] - price) * wh

    def trade_surplus(self, aid, trade):
        return self.surplus(aid, trade["wh"], trade["paise"], trade["delivery_start"])

    def utility(self, aid):
        return sum(self.trade_surplus(aid, t) for t in self.trades_of(aid))

    def pair_trade(self, seller, buyer):
        for t in self.trades.values():
            if t["seller_id"] == seller and t["buyer_id"] == buyer:
                return t
        return None

    def trade_out(self, trade, status=None):
        return {
            "id": trade["id"], "seller_id": trade["seller_id"],
            "buyer_id": trade["buyer_id"], "quantity_kwh": kwh(trade["wh"]),
            "price": inr(trade["paise"]), "payment": inr(trade["payment"]),
            "status": status or trade["status"], "version": trade["version"],
            "bundle": trade["bundle"], "run": trade["run"],
            "created_event_id": trade["created_event_id"],
            "released_event_id": trade.get("released_event_id"),
            "delivery_start": trade["delivery_start"], "delivery_end": trade["delivery_end"],
            "effective_floor": inr(trade["floor"]),
        }

    def trades_after(self):
        return [self.trade_out(t) for t in sorted(self.trades.values(), key=lambda t: t["id"])]

    def emit(self, etype, actor=None, counterparty=None, reason="", reason_code="",
             caused_by=(), transition=None, hop=None, **extra):
        self.sequence += 1
        event_id = f"{self.prefix}{self.sequence}"
        causes = [c for c in caused_by if c]
        if hop is None:
            hop = max((self.hop.get(c, 0) for c in causes), default=0)
        self.hop[event_id] = hop
        event = {
            "id": event_id, "sequence": self.sequence, "round": self.round,
            "type": etype, "actor_id": actor, "counterparty_id": counterparty,
            "reason": reason, "reason_code": reason_code, "caused_by": causes,
            "run": self.name, "depth": hop,
        }
        if transition is not None:
            event["transition_id"] = transition
        event.update(extra)
        if isinstance(event.get("trade"), dict):
            for field in ("delivery_start", "delivery_end"):
                event.setdefault(field, event["trade"].get(field))
        self.events.append(event)
        self.by_id[event_id] = event
        self.tail = event_id
        if etype in MESSAGE_TYPES:
            self.messages += 1
            if actor:
                self.sent[actor] += 1
        return event_id

    def next_event_id(self):
        return f"{self.prefix}{self.sequence + 1}"

    def can_message(self):
        """The cap is checked before every message. Hitting it ends the run
        at the last complete atomic state."""
        if self.messages < self.cfg["max_messages"]:
            return True
        self.limit_hit = True
        return False

    def publish_snapshot(self, event_ids):
        """Every event of one atomic transition shows the same final
        post-transition allocation, never an intermediate state."""
        after = self.trades_after()
        for event_id in event_ids:
            self.by_id[event_id]["trades_after"] = [dict(t) for t in after]

    def enqueue(self, aid, cause):
        if aid not in self.queue:
            self.queue.append(aid)
            self.queued_by[aid] = cause

    def bump(self, aid):
        self.agents[aid]["version"] += 1

    # -- proposals --

    def _proposal(self, mover, partner, drop, partner_drop, delivery=None):
        """One candidate proposal, or None. Public information only, except
        the mover's own private fields."""
        m, c = self.agents[mover], self.agents[partner]
        seller, buyer = (mover, partner) if m["role"] == "seller" else (partner, mover)
        s, b = self.agents[seller], self.agents[buyer]
        m_free = self.free_wh(mover) + (drop["wh"] if drop else 0)
        c_free = self.free_wh(partner) + (partner_drop["wh"] if partner_drop else 0)
        cap_free = self.cap_free + (drop["wh"] if drop else 0) + (
            partner_drop["wh"] if partner_drop else 0)
        if m_free <= 0 or c_free <= 0:
            return None
        if cap_free <= 0:
            return {"blocked": "cap_exhausted"}
        q = min(m_free, c_free, cap_free)
        bundle = False
        delivery_start = delivery[0] if delivery else None
        regular_floor = effective_floor_paise(dict(s, cond=None), q, delivery_start)
        price = price_paise(regular_floor, b["maximum"], self.tick)
        if price is None and mover == seller and s["cond"] and q >= s["cond"][1]:
            price = price_paise(s["cond"][0], b["maximum"], self.tick)
            bundle = price is not None
        if price is None:
            return None
        if self.cfg["negotiation_mode"] == "bargaining":
            floor = effective_floor_paise(s, q, delivery_start)
            price = quote_price(floor, b["maximum"], self.tick,
                                self.plan["agents"][mover]["price_positions"][0])
            bundle = s["cond"] is not None and q >= s["cond"][1] and price < regular_floor
        if mover == buyer:
            budget = self.free_budget(buyer) + (drop["payment"] if drop else 0)
            q = min(q, affordable_wh(budget, price))
        q -= q % ENERGY_TICK_WH
        if q <= 0 or (bundle and q < s["cond"][1]):
            return None
        gain = self.surplus(mover, q, price, delivery_start) - (self.trade_surplus(mover, drop) if drop else 0)
        if gain < EPSILON_RAW:
            return None
        partner_gain = self.surplus(partner, q, price, delivery_start) - (
            self.trade_surplus(partner, partner_drop) if partner_drop else 0)
        if partner_gain < (EPSILON_RAW if partner_drop else 0):
            return None
        return {"mover": mover, "partner": partner, "seller": seller, "buyer": buyer,
                "wh": q, "paise": price, "bundle": bundle, "drop": drop,
                "expect_partner_drop": partner_drop, "gain": gain,
                "partner_gain": partner_gain, "delivery": delivery}

    def proposal_key(self, p):
        return (p["mover"], p["partner"], p["wh"], p["paise"],
                p["drop"]["id"] if p["drop"] else None,
                *(p["delivery"] or (None, None)), self.plan_hash)

    def proposals(self, mover, partner, drop, partner_drop):
        seller = self.agents[mover if self.agents[mover]["role"] == "seller" else partner]
        timed = seller.get("time_price")
        for delivery in segments(self.agents[mover]["interval"],
                                 self.agents[partner]["interval"], timed[0] if timed else None):
            yield self._proposal(mover, partner, drop, partner_drop, delivery)

    def candidates(self, mover):
        """Ranked admissible proposals for one agent, plus blocking reasons."""
        m = self.agents[mover]
        blocked = set()
        if m["deadline"] is not None and self.round > m["deadline"]:
            return [], {"deadline_passed"}
        if self.free_wh(mover) <= 0 and not self.trades_of(mover):
            return [], {"over_supply" if m["role"] == "seller" else "over_demand"}
        found = {}
        own_drops = [None] + self.trades_of(mover)
        for partner in self.neighbors[mover]:
            if self.pair_trade(*((mover, partner) if m["role"] == "seller" else (partner, mover))):
                continue
            partner_drops = [None] + self.trades_of(partner)
            for drop in own_drops:
                for partner_drop in partner_drops:
                    for p in self.proposals(mover, partner, drop, partner_drop):
                        if p is None:
                            continue
                        if "blocked" in p:
                            blocked.add(p["blocked"])
                            continue
                        key = self.proposal_key(p)
                        if self.rejections.get(key) == (m["version"], self.agents[partner]["version"]):
                            continue
                        if key not in found or p["gain"] > found[key]["gain"]:
                            found[key] = p
        memory_on = self.cfg["memory_enabled"]

        def rank(p):
            return (-p["gain"], 0 if p["drop"] is None else 1,
                    0 if memory_on and p["partner"] in m["preferred"] else 1,
                    p["partner"], p["drop"]["id"] if p["drop"] else "")
        ranked = sorted(found.values(), key=rank)
        if not ranked and not blocked:
            blocked.add("no_candidates")
        return ranked, blocked

    # -- responses --

    def respond(self, p):
        """The responder's decision from its private state."""
        mover, partner = p["mover"], p["partner"]
        r = self.agents[partner]
        q, price = p["wh"], p["paise"]
        if p["delivery"] is None:
            return {"decision": "reject", "reason_code": "interval_mismatch"}
        if r["deadline"] is not None and self.round > r["deadline"]:
            return {"decision": "reject", "reason_code": "deadline_passed"}
        if r["role"] == "seller":
            if price < effective_floor_paise(r, q, p["delivery"][0]):
                return {"decision": "reject", "reason_code": "price_below_floor"}
        elif price > r["maximum"]:
            return {"decision": "reject", "reason_code": "price_above_max"}
        drop_wh = p["drop"]["wh"] if p["drop"] else 0
        cap_free = self.cap_free + drop_wh
        options = []
        reasons = []

        def bounded(extra_wh, extra_paise):
            limit = min(q, self.free_wh(partner) + extra_wh, cap_free + extra_wh)
            why = None
            if limit < q:
                why = ("over_supply" if r["role"] == "seller" else "over_demand") if (
                    self.free_wh(partner) + extra_wh < q) else "cap_exhausted"
            if r["role"] == "buyer":
                afford = affordable_wh(self.free_budget(partner) + extra_paise, price)
                if afford < limit:
                    limit, why = afford, "over_budget"
            limit -= limit % ENERGY_TICK_WH
            return limit, why

        q_a, why_a = bounded(0, 0)
        if q_a > 0:
            options.append((self.surplus(partner, q_a, price, p["delivery"][0]), 0, "", q_a, None, why_a))
        elif why_a:
            reasons.append(why_a)
        for trade in sorted(self.trades_of(partner),
                            key=lambda t: (self.trade_surplus(partner, t), t["id"])):
            q_b, why_b = bounded(trade["wh"], trade["payment"])
            if q_b <= 0:
                continue
            gain = self.surplus(partner, q_b, price, p["delivery"][0]) - self.trade_surplus(partner, trade)
            if gain >= EPSILON_RAW:
                options.append((gain, 1, trade["id"], q_b, trade, why_b))
        if not options:
            code = reasons[0] if reasons else "not_improving"
            return {"decision": "reject", "reason_code": code}
        options.sort(key=lambda o: (-o[0], o[1], o[2]))
        gain, _, _, q_x, displace, why = options[0]
        if q_x >= q:
            return {"decision": "accept", "wh": q, "displace": displace}
        return {"decision": "counter", "wh": q_x, "displace": displace,
                "reason_code": why or "not_improving"}

    def mover_accepts(self, p, q):
        gain = self.surplus(p["mover"], q, p["paise"], p["delivery"][0]) - (
            self.trade_surplus(p["mover"], p["drop"]) if p["drop"] else 0)
        if gain >= EPSILON_RAW:
            return None
        if p["bundle"] and q < self.agents[p["seller"]]["cond"][1]:
            return "bundle_below_minimum"
        return "not_improving"

    def checked_terms(self, p, q, partner_drop):
        """Validate the complete proposed allocation before any mutation."""
        if p["delivery"] is None:
            return ["interval_mismatch"]
        if any(self.agents[aid]["deadline"] is not None and
               self.round > self.agents[aid]["deadline"] for aid in (p["mover"], p["partner"])):
            return ["deadline_passed"]
        refusal = self.mover_accepts(p, q)
        if refusal:
            return [refusal]
        trial = copy.copy(self)
        trial.trades = dict(self.trades)
        for drop in (p["drop"], partner_drop):
            if drop:
                if drop["id"] not in trial.trades:
                    return ["stale_replacement"]
                del trial.trades[drop["id"]]
        floor = effective_floor_paise(self.agents[p["seller"]], q, p["delivery"][0])
        trial.trades["candidate"] = {
            "id": "candidate", "seller_id": p["seller"], "buyer_id": p["buyer"],
            "wh": q, "paise": p["paise"], "payment": payment_paise(q, p["paise"]),
            "delivery_start": p["delivery"][0], "delivery_end": p["delivery"][1],
            "floor": floor}
        problems = trial.violations()
        partner = p["partner"]
        gain = trial.utility(partner) - self.utility(partner)
        if gain < (EPSILON_RAW if partner_drop else 0):
            problems.append("responder_not_improving")
        return problems

    def bargain(self, original, cause):
        """At most three quotes per side, then acceptance or explicit rejection.

        The model selected the trajectories, not the outcomes. Each quote is
        executed against current quantities, budgets, delivery terms and prices.
        """
        p = dict(original)
        counts = {p["mover"]: 0, p["partner"]: 0}
        actor, receiver = p["mover"], p["partner"]
        last = cause
        reason = "strategy_exhausted"
        q = p["wh"]
        for exchange in range(6):
            if p["delivery"] is None:
                if not self.can_message():
                    return False
                own_window = self.agents[actor]["interval"]
                last = self.emit(
                    "offer_sent", actor, receiver,
                    f"{actor} proposes {kwh(q):.3f} kWh within its delivery window",
                    "delivery_offer", [last], quantity_kwh=kwh(q), price=inr(p["paise"]),
                    delivery_start=own_window[0], delivery_end=own_window[1],
                    strategy_plan_hash=self.plan_hash, strategy_step=0,
                    price_position=self.plan["agents"][actor]["price_positions"][0])
                reason = "interval_mismatch"
                break
            floor = effective_floor_paise(self.agents[p["seller"]], q, p["delivery"][0])
            maximum = self.agents[p["buyer"]]["maximum"]
            positions = self.plan["agents"][actor]["price_positions"]
            step = counts[actor]
            price = quote_price(floor, maximum, self.tick, positions[step])
            if price is None:
                reason = "price_below_floor"
                break
            p["paise"], p["wh"] = price, q
            if not self.can_message():
                return False
            last = self.emit(
                "offer_sent" if exchange == 0 else "counteroffer_sent", actor, receiver,
                f"{actor} proposes {kwh(q):.3f} kWh at INR {inr(price):.2f}/kWh",
                "strategy_quote", [last], quantity_kwh=kwh(q), price=inr(price),
                delivery_start=p["delivery"][0], delivery_end=p["delivery"][1],
                strategy_plan_hash=self.plan_hash, strategy_step=step,
                price_position=positions[step],
                replaces_trade_id=p["drop"]["id"] if p["drop"] else None)
            counts[actor] += 1
            answer = self.respond(p)
            if answer["decision"] == "reject":
                reason = answer["reason_code"]
                break
            budget_drop = p["drop"] if p["mover"] == p["buyer"] else answer["displace"]
            available_budget = self.free_budget(p["buyer"]) + (budget_drop["payment"] if budget_drop else 0)
            bounded_q = min(answer["wh"], affordable_wh(available_budget, price))
            other_step = min(counts[receiver], 2)
            aspiration = quote_price(floor, maximum, self.tick,
                self.plan["agents"][receiver]["price_positions"][other_step])
            acceptable = price >= aspiration if self.agents[receiver]["role"] == "seller" else price <= aspiration
            problems = self.checked_terms(p, bounded_q, answer["displace"])
            if acceptable and bounded_q == q and not problems:
                if not self.can_message():
                    return False
                accepted = self.emit(
                    "offer_accepted", receiver, actor,
                    f"{receiver} accepts {kwh(q):.3f} kWh at INR {inr(price):.2f}/kWh",
                    "accepted_quote", [last], quantity_kwh=kwh(q), price=inr(price),
                    delivery_start=p["delivery"][0], delivery_end=p["delivery"][1],
                    strategy_plan_hash=self.plan_hash, rule_checks=["all_constraints_passed"])
                self.reserve(p, q, receiver, accepted, p["drop"], answer["displace"])
                self.last_decision[p["mover"]] = f"reserved with {p['partner']}"
                self.last_decision[p["partner"]] = f"accepted {p['mover']}"
                return True
            q = bounded_q
            if counts[receiver] >= 3:
                reason = problems[0] if problems else "strategy_exhausted"
                break
            actor, receiver = receiver, actor
        if not self.can_message():
            return False
        self.emit("offer_rejected", receiver, actor, f"{receiver} rejects: {reason}", reason,
                  [last], quantity_kwh=kwh(q), price=inr(p["paise"]),
                  delivery_start=p["delivery"][0] if p["delivery"] else None,
                  delivery_end=p["delivery"][1] if p["delivery"] else None,
                  strategy_plan_hash=self.plan_hash, rejection_key=list(self.proposal_key(original)))
        self.record_rejection(original, reason)
        return False

    # -- transitions --

    def release(self, trade, reason_code, actor, caused_by, transition, hop, reason):
        """Remove one trade and record it. The caller publishes the snapshot
        once its whole transition is complete."""
        del self.trades[trade["id"]]
        trade["status"] = "released"
        trade["released_event_id"] = self.next_event_id()
        other = trade["buyer_id"] if actor == trade["seller_id"] else trade["seller_id"]
        event_id = self.emit("provisional_released", actor, other, reason, reason_code,
                             caused_by, transition, hop, trade=self.trade_out(trade))
        self.released.append(trade)
        self.bump(trade["seller_id"])
        self.bump(trade["buyer_id"])
        return event_id, other

    def reserve(self, p, q, accepted_by, cause, mover_drop, partner_drop):
        """One atomic transition: releases, then the new reservation. Every
        event in the group carries the same post-transition allocation."""
        problems = self.checked_terms(p, q, partner_drop)
        if problems:
            raise ValueError("unsafe reservation: " + "; ".join(problems))
        self.transition += 1
        transition = self.transition
        hop = self.hop.get(cause, 0) + 1
        mover, partner = p["mover"], p["partner"]
        before = {mover: raw_inr(self.utility(mover)), partner: raw_inr(self.utility(partner))}
        causes = [cause]
        group = []
        queue_after = []
        for drop, dropper, code in ((mover_drop, mover, "replaced"),
                                    (partner_drop, partner, "displaced")):
            if drop is None:
                continue
            replaced = self.emit(
                "offer_replaced", dropper, partner if dropper == mover else mover,
                f"{dropper} releases {drop['id']} to make room for a better trade",
                code, [cause], transition, hop, displaced_trade=self.trade_out(drop),
                quantity_kwh=kwh(q), price=inr(p["paise"]))
            released, other = self.release(drop, code, dropper, [replaced], transition, hop,
                                           f"{drop['id']} released: {code} by {dropper}")
            causes.append(replaced)
            group.extend([replaced, released])
            queue_after.append((other, replaced))
        seller = self.agents[p["seller"]]
        regular_floor = effective_floor_paise(dict(seller, cond=None), q, p["delivery"][0])
        bundle = bool(seller["cond"] and q >= seller["cond"][1] and p["paise"] < regular_floor)
        trade = {"id": f"trade-{self.next_trade:04d}", "seller_id": p["seller"],
                 "buyer_id": p["buyer"], "wh": q, "paise": p["paise"],
                 "payment": payment_paise(q, p["paise"]), "bundle": bundle,
                 "status": "provisional", "version": 1, "run": self.name,
                 "created_event_id": self.next_event_id(),
                 "delivery_start": p["delivery"][0], "delivery_end": p["delivery"][1],
                 "floor": effective_floor_paise(self.agents[p["seller"]], q, p["delivery"][0])}
        self.next_trade += 1
        self.trades[trade["id"]] = trade
        event_id = self.emit(
            "provisional_reserved", accepted_by, partner if accepted_by == mover else mover,
            f"{trade['seller_id']} sells {kwh(q):.3f} kWh to {trade['buyer_id']} at"
            f" INR {inr(p['paise']):.2f}/kWh", "accepted", causes, transition, hop,
            trade=self.trade_out(trade), quantity_kwh=kwh(q), price=inr(p["paise"]),
            rule_checks=["supply_ok", "demand_ok", "budget_ok", "price_ok", "interval_ok",
                         "deadline_ok", "cap_ok", "edge_ok"],
            utility_before=before,
            utility_after={mover: raw_inr(self.utility(mover)),
                           partner: raw_inr(self.utility(partner))})
        group.append(event_id)
        self.publish_snapshot(group)
        self.bump(mover)
        self.bump(partner)
        self.enqueue(partner, event_id)
        for other, replaced in queue_after:
            self.enqueue(other, replaced)
        if self.free_wh(mover) > 0:
            self.enqueue(mover, event_id)
        return event_id

    def record_rejection(self, p, reason_code):
        if reason_code == "cap_exhausted":
            return
        self.rejections[self.proposal_key(p)] = (self.agents[p["mover"]]["version"],
                                                 self.agents[p["partner"]]["version"])

    def take_turn(self, mover):
        cause = self.queued_by.get(mover)
        ranked, blocked = self.candidates(mover)
        if ranked and self.cfg["memory_enabled"]:
            top = ranked[0]
            tie = any(p["gain"] == top["gain"] and (p["drop"] is None) == (top["drop"] is None)
                      and p["partner"] != top["partner"] for p in ranked[1:])
            if tie and top["partner"] in self.agents[mover]["preferred"]:
                record = self.agents[mover]["memory_ids"][top["partner"]]
                cause = self.emit("profile_retrieved", mover, top["partner"],
                                  f"memory record {record} prefers {top['partner']} among"
                                  " equal candidates", "memory_tie_break", [cause],
                                  memory_ids=[record])
        for p in ranked[:self.cfg["max_offers_per_turn"]]:
            if self.cfg["negotiation_mode"] == "bargaining":
                if self.bargain(p, cause):
                    return True
                if self.limit_hit:
                    return False
                continue
            if not self.can_message():
                return False
            offer = self.emit(
                "offer_sent", mover, p["partner"],
                f"{mover} proposes {kwh(p['wh']):.3f} kWh at INR {inr(p['paise']):.2f}/kWh",
                "bundle_offer" if p["bundle"] else "fill_offer", [cause],
                quantity_kwh=kwh(p["wh"]), price=inr(p["paise"]), bundle=p["bundle"], delivery_start=p["delivery"][0] if p["delivery"] else None,
                delivery_end=p["delivery"][1] if p["delivery"] else None,
                replaces_trade_id=p["drop"]["id"] if p["drop"] else None,
                expected_gain=raw_inr(p["gain"]))
            answer = self.respond(p)
            if not self.can_message():
                return False
            if answer["decision"] == "reject":
                self.emit("offer_rejected", p["partner"], mover,
                          f"{p['partner']} rejects: {answer['reason_code']}",
                          answer["reason_code"], [offer], rejection_key=list(self.proposal_key(p)), quantity_kwh=kwh(p["wh"]),
                          price=inr(p["paise"]))
                self.record_rejection(p, answer["reason_code"])
                self.last_decision[p["partner"]] = f"rejected {mover}: {answer['reason_code']}"
                continue
            last = offer
            q = answer["wh"]
            if answer["decision"] == "counter":
                last = self.emit(
                    "counteroffer_sent", p["partner"], mover,
                    f"{p['partner']} can take {kwh(q):.3f} kWh at the same price:"
                    f" {answer['reason_code']}", answer["reason_code"], [offer],
                    quantity_kwh=kwh(q), price=inr(p["paise"]),
                    delivery_start=p["delivery"][0], delivery_end=p["delivery"][1])
                refusal = self.mover_accepts(p, q)
                if refusal:
                    if not self.can_message():
                        return False
                    self.emit("offer_rejected", mover, p["partner"],
                              f"{mover} rejects the counteroffer: {refusal}", refusal,
                              [last], rejection_key=list(self.proposal_key(p)), quantity_kwh=kwh(q), price=inr(p["paise"]))
                    self.record_rejection(p, refusal)
                    self.last_decision[mover] = f"rejected counteroffer from {p['partner']}: {refusal}"
                    continue
                accepted_by = mover
            else:
                accepted_by = p["partner"]
            self.reserve(p, q, accepted_by, last, p["drop"], answer["displace"])
            self.last_decision[mover] = f"reserved with {p['partner']}"
            self.last_decision[p["partner"]] = f"accepted {mover}"
            return True
        code = sorted(blocked)[0] if blocked else "all_rejected"
        self.emit("no_improving_move", mover, None,
                  f"{mover} found no admissible improving proposal: {code}", code, [cause],
                  candidates_evaluated=len(ranked))
        self.last_decision[mover] = f"no improving move: {code}"
        return False

    def sweep(self):
        return [aid for aid in sorted(self.agents) if self.candidates(aid)[0]]

    # -- protocol loop --

    def negotiate(self):
        self.hashes.add(state_hash(self.trades.values()))
        while True:
            if not self.queue:
                movers = self.sweep()
                check = self.emit("stability_checked", None, None,
                                  f"sweep over {len(self.agents)} agents found"
                                  f" {len(movers)} with an admissible proposal",
                                  "sweep", [self.tail], agents_with_moves=movers)
                if not movers:
                    self.status, self.termination_reason = "locally_stable", "sweep_clean"
                    return
                for aid in movers:
                    self.enqueue(aid, check)
            if self.round >= self.max_rounds:
                self.status, self.termination_reason = "round_limited", "max_rounds"
                return
            self.round += 1
            snapshot, self.queue = self.queue, []
            for aid in snapshot:
                changed = self.take_turn(aid)
                if self.limit_hit:
                    self.status, self.termination_reason = "round_limited", "max_messages"
                    return
                if changed:
                    digest = state_hash(self.trades.values())
                    if digest in self.hashes:
                        self.emit("cycle_detected", aid, None,
                                  "the provisional allocation repeated an earlier state",
                                  "cycle", [self.tail], state_hash=digest)
                        self.status, self.termination_reason = "cycle_detected", "repeated_state"
                        return
                    self.hashes.add(digest)

    def violations(self):
        problems = []
        pairs = set()
        for t in self.trades.values():
            s, b = self.agents[t["seller_id"]], self.agents[t["buyer_id"]]
            pair = (t["seller_id"], t["buyer_id"])
            if pair in pairs:
                problems.append(f"duplicate pair {pair}")
            pairs.add(pair)
            if t["buyer_id"] not in self.neighbors[t["seller_id"]]:
                problems.append(f"{t['id']} outside discovery network")
            if t["wh"] <= 0 or t["wh"] % ENERGY_TICK_WH:
                problems.append(f"{t['id']} invalid energy tick")
            if t["paise"] < 0 or t["paise"] % self.tick:
                problems.append(f"{t['id']} invalid price tick")
            delivery = (t.get("delivery_start"), t.get("delivery_end"))
            valid_delivery = contains(s["interval"], delivery) and contains(b["interval"], delivery)
            if not valid_delivery:
                problems.append(f"{t['id']} interval mismatch")
            elif t["paise"] < effective_floor_paise(s, t["wh"], delivery[0]) or t["paise"] > b["maximum"]:
                problems.append(f"{t['id']} price outside band")
            if t["payment"] != payment_paise(t["wh"], t["paise"]):
                problems.append(f"{t['id']} payment mismatch")
        for aid, a in self.agents.items():
            if a["role"] == "seller" and self.reserved_wh(aid) > a["offer_wh"]:
                problems.append(f"{aid} over supply")
            if a["role"] == "buyer":
                if self.reserved_wh(aid) > a["demand_wh"]:
                    problems.append(f"{aid} over demand")
                if self.spent(aid) > a["budget"]:
                    problems.append(f"{aid} over budget")
        if self.reserved_cap > self.cap_total:
            problems.append("utility cap exceeded")
        return problems

    def finalize(self):
        problems = self.violations()
        if problems:
            self.emit("validation_failed", None, None, "; ".join(problems), "invariant",
                      [self.tail], problems=problems)
            self.status, self.termination_reason = "unresolved", "invariant_failed"
        else:
            for t in self.trades.values():
                t["status"] = "committed"
            self.emit("commitment_finalized", None, None,
                      f"{len(self.trades)} provisional trades committed after termination"
                      f" ({self.status})", "committed", [self.tail],
                      trades_after=self.trades_after())
        scope = {"locally_stable": STABILITY_SCOPE_STABLE,
                 "round_limited": STABILITY_SCOPE_LIMITED,
                 "cycle_detected": STABILITY_SCOPE_CYCLE,
                 "unresolved": STABILITY_SCOPE_UNRESOLVED}[self.status]
        self.emit("terminated", None, None, f"{self.status}: {self.termination_reason}",
                  self.status, [self.tail], termination_reason=self.termination_reason,
                  stability_scope=scope, rounds=self.round, messages=self.messages)
        return scope, problems

    def result(self, started):
        scope, problems = self.finalize()
        trades = self.trades_after()
        prices = [t["paise"] for t in self.trades.values()]
        total_wh = sum(t["wh"] for t in self.trades.values())
        weighted = sum(t["wh"] * t["paise"] for t in self.trades.values())
        welfare = sum(self.trade_surplus(t["seller_id"], t) + self.trade_surplus(t["buyer_id"], t)
                      for t in self.trades.values())
        agents = {}
        for aid in sorted(self.agents):
            a = self.agents[aid]
            summary = {"utility": raw_inr(self.utility(aid)),
                       "reserved_kwh": kwh(self.reserved_wh(aid)),
                       "free_kwh": kwh(self.free_wh(aid)),
                       "trade_ids": [t["id"] for t in self.trades_of(aid)],
                       "messages_sent": self.sent[aid],
                       "last_decision": self.last_decision[aid]}
            if a["role"] == "buyer":
                summary["spent"] = inr(self.spent(aid))
                summary["budget_left"] = inr(self.free_budget(aid))
            agents[aid] = summary
        metrics = {
            "committed_kwh": kwh(total_wh), "trade_count": len(trades),
            "unfilled_demand_kwh": kwh(sum(self.free_wh(a) for a in self.agents
                                           if self.agents[a]["role"] == "buyer")),
            "unused_surplus_kwh": kwh(sum(self.free_wh(a) for a in self.agents
                                          if self.agents[a]["role"] == "seller")),
            "mean_price": round(inr(weighted / total_wh), 4) if total_wh else None,
            "median_price": inr(statistics.median(prices)) if prices else None,
            "welfare": raw_inr(welfare),
            "payments": inr(sum(t["payment"] for t in self.trades.values())),
            "message_count": self.messages,
            "rounds": self.round, "status": self.status,
            "hard_constraint_violations": len(problems), "duplicate_reservations": 0,
            "released_count": len(self.released),
            "runtime_seconds": round(time.perf_counter() - started, 4),
        }
        return {"run": self.name, "events": self.events, "trades": trades,
                "released_trades": [self.trade_out(t) for t in self.released],
                "metrics": metrics, "status": self.status,
                "termination_reason": self.termination_reason, "stability_scope": scope,
                "strategy_plan": copy.deepcopy(self.plan),
                "rounds": self.round, "messages": self.messages,
                "final_state_hash": state_hash(self.trades.values()), "agents": agents}


# -- interventions -----------------------------------------------------------


def _preset_changes(agent, scenario):
    if scenario == "price":
        if agent["role"] == "seller":
            return {"min_price": round(agent["min_price"] + 0.5, 2)}
        return {"max_price": round(max(0.0, agent["max_price"] - 0.5), 2)}
    if scenario == "supply":
        if agent["role"] == "seller":
            return {"forecast_surplus_kwh": math.floor(agent["forecast_surplus_kwh"] * 5) / 10}
        return {"demand_kwh": math.floor(agent["demand_kwh"] * 15) / 10}
    if scenario == "budget":
        if agent["role"] == "buyer":
            return {"budget": math.floor(agent["budget"] * 60) / 100, "deadline_round": 4}
        return {"deadline_round": 4}
    raise ValueError(f"no preset for scenario {scenario!r}")


def _validate_changes(agent, changes, tick):
    allowed = SELLER_CHANGES if agent["role"] == "seller" else BUYER_CHANGES
    if not isinstance(changes, dict) or not changes:
        raise ValueError("custom interventions need a non-empty changes object")
    unknown = sorted(set(changes) - allowed)
    if unknown:
        raise ValueError(f"fields {unknown} cannot be changed for a {agent['role']}")
    updated = copy.deepcopy(agent)
    updated.update(copy.deepcopy(changes))
    agent_state(updated, tick)
    return updated


def _apply_intervention(world, intervention, tick):
    """Returns (updated_world, changed_fields, changed_agent_ids)."""
    if not isinstance(intervention, dict):
        raise ValueError("intervention must be an object")
    scenario = intervention.get("scenario", "custom")
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario!r}")
    agent_id = intervention.get("agent_id")
    agents = {a["id"]: a for a in world["agents"]}
    if agent_id not in agents:
        raise ValueError(f"unknown agent {agent_id!r}")
    if scenario == "none":
        return None, [], []
    changes = intervention.get("changes") or {}
    plan = []
    if scenario == "shock" and not changes:
        for aid, agent in agents.items():
            if agent["role"] == "seller":
                plan.append((aid, {"forecast_surplus_kwh":
                                   math.floor(agent["forecast_surplus_kwh"] * 7) / 10}))
    elif changes:
        plan.append((agent_id, changes))
    else:
        plan.append((agent_id, _preset_changes(agents[agent_id], scenario)))
    updated_world = copy.deepcopy(world)
    updated_agents = {a["id"]: a for a in updated_world["agents"]}
    changed_fields = []
    for aid, change in plan:
        updated = _validate_changes(agents[aid], change, tick)
        for field in sorted(change):
            if agents[aid][field] != updated[field]:
                changed_fields.append({"agent_id": aid, "field": field,
                                       "before": agents[aid][field],
                                       "after": updated[field]})
        updated_agents[aid].update({k: updated[k] for k in change})
    return updated_world, changed_fields, [aid for aid, _ in plan]


def _repair(run, changed_ids, policy_event):
    """Release every trade the new policies no longer allow, as one atomic
    transition whose snapshots all show the post-repair allocation."""
    run.transition += 1
    transition = run.transition
    hop = run.hop[policy_event] + 1
    group = []
    released_partners = []

    def drop(aid, trade, code):
        event_id, other = run.release(trade, code, aid, [policy_event], transition, hop,
                                      f"{trade['id']} no longer satisfies {aid}: {code}")
        group.append(event_id)
        released_partners.append((other, event_id))

    for aid in changed_ids:
        a = run.agents[aid]
        for trade in run.trades_of(aid):
            other = run.agents[trade["buyer_id"] if a["role"] == "seller" else trade["seller_id"]]
            delivery = (trade["delivery_start"], trade["delivery_end"])
            if not contains(a["interval"], delivery) or not contains(other["interval"], delivery):
                drop(aid, trade, "interval_mismatch")
            elif a["role"] == "seller" and trade["paise"] < effective_floor_paise(a, trade["wh"], trade["delivery_start"]):
                drop(aid, trade, "price_below_floor")
            elif a["role"] == "buyer" and trade["paise"] > a["maximum"]:
                drop(aid, trade, "price_above_max")
        by_surplus = lambda t: (run.trade_surplus(aid, t), t["id"])
        while run.reserved_wh(aid) > (a["offer_wh"] if a["role"] == "seller" else a["demand_wh"]):
            drop(aid, min(run.trades_of(aid), key=by_surplus),
                 "over_supply" if a["role"] == "seller" else "over_demand")
        while a["role"] == "buyer" and run.spent(aid) > a["budget"]:
            drop(aid, min(run.trades_of(aid), key=by_surplus), "over_budget")
    if group:
        run.publish_snapshot(group)
    else:
        run.transition -= 1
    return released_partners


# -- comparison and manifest -------------------------------------------------


def _trade_key(t):
    return (t["seller_id"], t["buyer_id"], round(t["quantity_kwh"] * 1000),
            round(t["price"] * 100), t.get("delivery_start"), t.get("delivery_end"))


def _comparison(base, inter, origins, controlled, scenario):
    """Direct and indirect effects are classified against the actual policy
    origins (one agent, or every changed seller in a common shock), not
    against messages. Message reach is reported separately."""
    base_keys = sorted(_trade_key(t) for t in base["trades"])
    inter_keys = sorted(_trade_key(t) for t in inter["trades"])
    removed = list(base_keys)
    added = []
    for key in inter_keys:
        if key in removed:
            removed.remove(key)
        else:
            added.append(key)
    changed = removed + added
    origin_set = set(origins)
    affected = sorted({k[0] for k in changed} | {k[1] for k in changed})
    direct = set()
    for seller_id, buyer_id, *_ in changed:
        if (seller_id in origin_set) != (buyer_id in origin_set):
            direct.add(buyer_id if seller_id in origin_set else seller_id)
    for t in inter["released_trades"]:
        if (t["seller_id"] in origin_set) != (t["buyer_id"] in origin_set):
            direct.add(t["buyer_id"] if t["seller_id"] in origin_set else t["seller_id"])
    direct = sorted(direct)
    indirect = [a for a in affected if a not in direct and a not in origin_set]
    messaged = set()
    contacts = set()
    for e in inter["events"]:
        if e["type"] in MESSAGE_TYPES:
            parties = {e["actor_id"], e["counterparty_id"]} - {None}
            messaged |= parties
            if parties & origin_set:
                contacts |= parties - origin_set
    deltas = {aid: round(inter["agents"][aid]["utility"] - base["agents"][aid]["utility"], 5)
              for aid in base["agents"]}
    comparison = {
        "controlled_agent": controlled, "scenario": scenario,
        "origin_agents": sorted(origin_set),
        "changed_trades": len(changed),
        "removed_trades": [list(k) for k in removed],
        "added_trades": [list(k) for k in added],
        "changed_kwh": kwh(sum(k[2] for k in changed)),
        "displaced_count": inter["metrics"]["released_count"],
        "affected_agents": affected, "direct_agents": direct,
        "indirect_agents": indirect,
        "messaged_agents": sorted(messaged),
        "origin_contacts": sorted(contacts),
        "cascade_depth": max((e["depth"] for e in inter["events"]
                              if e["type"] in RESERVATION_TYPES), default=0),
        "welfare_delta": round(inter["metrics"]["welfare"] - base["metrics"]["welfare"], 5),
        "gaining_agents": sorted(aid for aid, delta in deltas.items() if delta > 0),
        "losing_agents": sorted(aid for aid, delta in deltas.items() if delta < 0),
        "agent_utility_deltas": deltas,
        "baseline_metrics": base["metrics"], "intervention_metrics": inter["metrics"],
        "baseline_status": base["status"], "intervention_status": inter["status"],
        "messages": inter["messages"], "rounds": inter["rounds"],
    }
    if base["status"] != "locally_stable":
        comparison["caveat"] = ("baseline terminated " + base["status"] + "; the intervention"
                                " run may also contain continued baseline negotiation")
    return comparison


def strip_runtime(result):
    stripped = copy.deepcopy(result)
    for name in ("baseline", "intervention"):
        if stripped.get(name):
            stripped[name]["metrics"].pop("runtime_seconds", None)
    return stripped


def _source_fingerprint():
    try:
        with open(__file__, "rb") as handle:
            return "sha256:" + hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


# -- public entry points -----------------------------------------------------


def run_experiment(config, intervention=None, world=None, strategy_plan=None, *,
                   checksum_version=CHECKSUM_VERSION):
    """Run a baseline and, when asked, a cloned intervention. Pure: inputs are
    never mutated, and identical inputs give identical outputs apart from
    runtime_seconds."""
    cfg, tick, cap_wh = _validate_config(config)
    if world is None:
        world = build_world(cfg)
    else:
        world = copy.deepcopy(world)
        make_world(world["agents"], cfg)
    strategy_plan = validate_strategy_plan(
        strategy_plan if strategy_plan is not None else default_strategy_plan(world["agents"]),
        world["agents"])
    started = time.perf_counter()
    base = _Run(world, cfg, tick, cap_wh, "baseline", strategy_plan, checksum_version)
    root = base.emit("world_generated", None, None,
                     f"{len(base.agents)} agents, {cfg['topology']} discovery,"
                     f" seed {cfg['seed']}", "seeded",
                     population=len(base.agents), seed=cfg["seed"], topology=cfg["topology"])
    for aid in sorted(base.agents):
        base.enqueue(aid, root)
    base.negotiate()
    base_result = base.result(started)

    updated_world, inter_result, comparison, changed_fields = None, None, None, []
    scenario = None
    if intervention is not None and intervention.get("scenario", "custom") != "none":
        scenario = intervention.get("scenario", "custom")
        updated_world, changed_fields, changed_ids = _apply_intervention(world, intervention, tick)
        started = time.perf_counter()
        inter = base.clone_for("intervention")
        updated = {a["id"]: a for a in updated_world["agents"]}
        origins = sorted(changed_ids)
        policy = inter.emit(
            "policy_confirmed", intervention["agent_id"], None,
            f"{len(changed_fields)} field(s) changed under scenario {scenario}",
            "policy_changed", [], changed_fields=changed_fields, scenario=scenario,
            origin_agents=origins,
            source_policy_version=f"policy-{intervention['agent_id']}-v2")
        for aid in origins:
            # Keep the version history: a stale rejection cached against the
            # old version must not look current after the policy changed.
            previous = inter.agents[aid]["version"]
            inter.agents[aid] = agent_state(updated[aid], tick)
            inter.agents[aid]["version"] = previous + 1
        displaced = _repair(inter, origins, policy)
        for aid in origins:
            inter.enqueue(aid, policy)
        for other, cause in displaced:
            inter.enqueue(other, cause)
        inter.negotiate()
        inter_result = inter.result(started)
        comparison = _comparison(base_result, inter_result, origins,
                                 intervention["agent_id"], scenario)
    elif intervention is not None:
        _apply_intervention(world, intervention, tick)
        scenario = "none"

    checksums = {
        "world": fingerprint(world, checksum_version),
        "baseline_events": fingerprint(base_result["events"], checksum_version),
        "baseline_trades": fingerprint(base_result["trades"], checksum_version),
        "intervention_events": fingerprint(inter_result["events"], checksum_version) if inter_result else None,
        "intervention_trades": fingerprint(inter_result["trades"], checksum_version) if inter_result else None,
        "engine_source": _source_fingerprint(),
    }
    manifest = {
        "protocol_version": PROTOCOL_VERSION, "engine_version": ENGINE_VERSION,
        "checksum_version": checksum_version,
        "config": copy.deepcopy(config), "population": len(world["agents"]),
        "seed": cfg["seed"], "topology": cfg["topology"],
        "intervention": copy.deepcopy(intervention), "scenario": scenario,
        "changed_fields": changed_fields,
        "price_rule": PRICE_RULE if cfg["negotiation_mode"] == "midpoint" else
            "bounded alternating price quotes from the frozen strategy plan; accepted quote sets price",
        "strategy_plan": strategy_plan, "strategy_plan_hash": fingerprint(strategy_plan, checksum_version),
        "energy_model": "One flexible energy pool per household over its delivery window; no power, device or per-hour generation limits.",
        "utility_formula": UTILITY_FORMULA,
        "admissible_moves": ADMISSIBLE_MOVES,
        "stability_scope": STABILITY_SCOPE_STABLE,
        "units": {"energy": "kWh (whole watt hours internally)",
                  "money": "INR (whole paise internally)", "price_tick": cfg["price_tick"],
                  "epsilon": "1 paise of total utility"},
        "interval": world["interval"], "synthetic": True,
        "checksums": checksums,
    }
    return {"world": world, "updated_world": updated_world, "baseline": base_result,
            "intervention": inter_result, "comparison": comparison, "manifest": manifest}


def _snapshot_trade(t):
    return {"id": t["id"], "seller_id": t["seller_id"], "buyer_id": t["buyer_id"],
            "wh": round(t["quantity_kwh"] * 1000), "paise": round(t["price"] * 100),
            "payment": round(t["payment"] * 100), "bundle": t["bundle"],
            "status": t["status"], "version": t["version"], "run": t["run"],
            "created_event_id": t["created_event_id"],
            "delivery_start": t.get("delivery_start"), "delivery_end": t.get("delivery_end"),
            "floor": round(t.get("effective_floor", 0) * 100)}


def _verify_snapshots(name, world, cfg, tick, cap_wh, run, carried, seen, problems):
    """Every published allocation snapshot must satisfy the hard constraints,
    agree across its atomic transition, cite real reservation events, and
    differ from the previous snapshot by exactly that transition's releases
    and reservations. Returns the final snapshot."""
    groups = []
    for e in run["events"]:
        if "trades_after" not in e:
            continue
        tid = e.get("transition_id")
        if tid is not None and groups and groups[-1][0].get("transition_id") == tid:
            groups[-1].append(e)
        else:
            groups.append([e])
    current = {t["id"]: _trade_key(t) for t in carried}
    for group in groups:
        first = group[0]
        keys = [canonical_json(sorted(e["trades_after"], key=lambda t: t["id"]))
                for e in group]
        if any(k != keys[0] for k in keys[1:]):
            problems.append(f"{name}: transition {first.get('transition_id')} publishes"
                            " different snapshots on its events")
        group_ids = {e["id"] for e in group}
        check = _Run(world, cfg, tick, cap_wh, name, run.get("strategy_plan"))
        for t in first["trades_after"]:
            check.trades[t["id"]] = _snapshot_trade(t)
            creator = t["created_event_id"]
            if creator not in group_ids and (creator not in seen
                                             or seen[creator]["type"] != "provisional_reserved"):
                problems.append(f"{name}: {first['id']} shows {t['id']} without a reservation event")
        problems.extend(f"{name}: {first['id']}: {p}" for p in check.violations())
        snapshot = {t["id"]: _trade_key(t) for t in first["trades_after"]}
        released = {e["trade"]["id"] for e in group if e["type"] == "provisional_released"}
        reserved = {e["trade"]["id"] for e in group if e["type"] == "provisional_reserved"}
        removed = {tid for tid in current if tid not in snapshot}
        added = {tid for tid in snapshot if tid not in current}
        if removed != released or added != reserved:
            problems.append(f"{name}: {first['id']} snapshot does not match the transition's"
                            f" releases {sorted(released)} and reservations {sorted(reserved)}")
        if any(snapshot[tid] != current[tid] for tid in snapshot if tid in current):
            problems.append(f"{name}: {first['id']} changes a trade that was not released")
        current = snapshot
    return current


def verify_result(result):
    """Recompute every invariant from the returned data, including every
    published replay snapshot. Returns a list of problems, empty when the
    result is consistent."""
    problems = []
    try:
        checksum_version = result["manifest"].get("checksum_version", LEGACY_CHECKSUM_VERSION)
        if checksum_version not in (CHECKSUM_VERSION, LEGACY_CHECKSUM_VERSION):
            return [f"unsupported checksum version: {checksum_version}"]
        cfg, tick, cap_wh = _validate_config(result["manifest"]["config"])
    except (KeyError, ValueError) as exc:
        return [f"manifest config invalid: {exc}"]
    runs = [("baseline", result["world"], [])]
    if result.get("intervention"):
        runs.append(("intervention", result["updated_world"], result["baseline"]["trades"]))
    rejections = {}
    versions = {}
    seen = {}
    for name, world, carried in runs:
        run = result[name]
        if run["status"] not in STATUSES:
            problems.append(f"{name}: unknown status {run['status']}")
        prefix = "ev-" if name == "baseline" else "iv-"
        for i, e in enumerate(run["events"], start=1):
            if e["sequence"] != i or e["id"] != f"{prefix}{i}":
                problems.append(f"{name}: event {e['id']} out of sequence")
            for cause in e["caused_by"]:
                if cause not in seen:
                    problems.append(f"{name}: {e['id']} cites unknown cause {cause}")
            seen[e["id"]] = e
            if e["type"] in ("provisional_reserved", "provisional_released"):
                for aid in (e["actor_id"], e["counterparty_id"]):
                    versions[aid] = versions.get(aid, 0) + 1
            if e["type"] == "policy_confirmed":
                for aid in e["origin_agents"]:
                    versions[aid] = versions.get(aid, 0) + 1
            if e["type"] == "offer_rejected" and e.get("rejection_key"):
                key = tuple(e["rejection_key"])
                rejections[key] = (versions.get(key[0], 0), versions.get(key[1], 0))
            if e["type"] in MESSAGE_TYPES:
                for key in PRIVATE_FIELDS:
                    if key in e:
                        problems.append(f"{name}: {e['id']} exposes private field {key}")
        check = _Run(world, cfg, tick, cap_wh, name, run.get("strategy_plan"), checksum_version)
        for t in run["trades"]:
            if t["status"] not in ("committed", "provisional"):
                problems.append(f"{name}: {t['id']} has status {t['status']}")
            if t["created_event_id"] not in seen or seen[t["created_event_id"]]["type"] != "provisional_reserved":
                problems.append(f"{name}: {t['id']} has no reservation event")
            check.trades[t["id"]] = _snapshot_trade(t)
        problems.extend(f"{name}: {p}" for p in check.violations())
        last = _verify_snapshots(name, world, cfg, tick, cap_wh, run, carried, seen, problems)
        final = {t["id"]: _trade_key(t) for t in run["trades"]}
        if last != final:
            problems.append(f"{name}: final trades differ from the last published snapshot")
        if run["status"] == "locally_stable" and not problems:
            check.round = run["rounds"]
            for aid in check.agents:
                check.agents[aid]["version"] = versions.get(aid, 0)
            for key, version in rejections.items():
                if (versions.get(key[0], 0), versions.get(key[1], 0)) == version:
                    check.rejections[key] = version
            leftover = check.sweep()
            if leftover:
                problems.append(f"{name}: claims locally stable but {leftover} still have moves")
        if run["status"] != "unresolved" and any(t["status"] != "committed" for t in run["trades"]):
            problems.append(f"{name}: terminated run left uncommitted trades")
    if result.get("comparison"):
        base_keys = sorted(_trade_key(t) for t in result["baseline"]["trades"])
        inter_keys = sorted(_trade_key(t) for t in result["intervention"]["trades"])
        removed = list(base_keys)
        added = 0
        for key in inter_keys:
            if key in removed:
                removed.remove(key)
            else:
                added += 1
        if result["comparison"]["changed_trades"] != len(removed) + added:
            problems.append("comparison: changed_trades does not match the trade lists")
    try:
        manifest = result["manifest"]
        expected = {
            "world": fingerprint(result["world"], checksum_version),
            "baseline_events": fingerprint(result["baseline"]["events"], checksum_version),
            "baseline_trades": fingerprint(result["baseline"]["trades"], checksum_version),
            "intervention_events": fingerprint(result["intervention"]["events"], checksum_version) if result.get("intervention") else None,
            "intervention_trades": fingerprint(result["intervention"]["trades"], checksum_version) if result.get("intervention") else None,
        }
        for key, value in expected.items():
            if manifest["checksums"].get(key) != value:
                problems.append(f"manifest checksum mismatch: {key}")
        normalized = validate_strategy_plan(manifest["strategy_plan"], result["world"]["agents"])
        if fingerprint(normalized, checksum_version) != manifest["strategy_plan_hash"]:
            problems.append("strategy plan hash mismatch")
        replayed = run_experiment(manifest["config"], manifest["intervention"],
                                  world=result["world"], strategy_plan=normalized,
                                  checksum_version=checksum_version)
        for name in ("baseline", "intervention"):
            if result.get(name) != replayed.get(name):
                recorded = copy.deepcopy(result.get(name))
                replay = copy.deepcopy(replayed.get(name))
                if recorded and replay:
                    recorded["metrics"].pop("runtime_seconds", None)
                    replay["metrics"].pop("runtime_seconds", None)
                if recorded != replay:
                    problems.append(f"{name}: recorded decisions differ from deterministic replay")
    except (KeyError, TypeError, ValueError) as exc:
        problems.append(f"replay invalid: {exc}")
    return problems
