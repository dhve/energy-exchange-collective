# Collective energy sandbox implementation plan

> For agentic workers: Use the execution and test-driven-development skills. Preserve the user's requested Codex and Claude Fable 5.1 Ultracode collaboration.

Goal: Deliver a reproducible 20/50/100-agent energy negotiation sandbox with a working local preview.

Architecture: A pure Python engine returns a complete paired experiment. A stateless FastAPI service validates requests and serves a browser workspace. All graphics and analysis consume the returned trace.

Tech stack: Python 3.11+, FastAPI, Pydantic, standard browser JavaScript, CSS, SVG, unittest.

Spec: docs/superpowers/specs/2026-10-27-collective-design.md, based on the supplied collective negotiation specification.

## Global constraints

Synthetic data only. No production calls or messages to project participants. The user subsequently authorized a public GitHub repository and requested a possible Streamlit deployment. Preserve legacy files and tests. Population {20,50,100}, seed 42 default, single interval, local/open topology, 12 rounds default, price tick 0.05. No claims of Nash equilibrium or physical network feasibility.

## Review focus

1. Partial natural-language parses must not silently drop unsupported conditions.
2. Replaying a replacement must release prior reservations at the same atomic transition.
3. Price rounding and bundle thresholds must not violate a floor or budget.
4. Editing inputs after a run must visibly invalidate the pending policy preview.
5. Metrics must separate messages from changed allocations, and causal references must resolve.

## Shared JSON contract

Engine module: `src/energy_exchange/collective_engine.py`.

`run_experiment(config: dict, intervention: dict | None = None) -> dict`.

Config fields: `population`, `seed`, `topology` (`local`/`open`), `max_rounds`, `max_messages`, `utility_cap_kwh`, `memory_enabled`, `price_tick`.

Intervention fields: `agent_id`, `changes` (typed policy fields), `scenario` (`custom`, `price`, `supply`, `budget`, `shock`, `none`). The HTTP boundary requires an explicit `confirmed` flag before accepting a custom change. The pure engine receives validated data but must still enforce hard constraints.

Agent fields: `id`, `name`, `role`, `context`, `interval_start`, `interval_end`, `timezone`, `forecast_surplus_kwh`, `reserve_kwh`, `max_offer_kwh`, `min_price`, `conditional_price` (`floor`, `minimum_kwh`, or null), `demand_kwh`, `max_price`, `budget`, `deadline_round`, `memory` (records with `id`, `text`, structured soft preference). Inapplicable role fields may be null. IDs A01 to A100 are stable, odd IDs sellers, even IDs buyers; controlled default A17.

Result fields: `world` (`agents`, `discovery_edges`, `config`), `updated_world`, `baseline`, `intervention`, `comparison`, `manifest`. A run contains `events`, `trades`, `metrics`, `status`, `stability_scope`. A trade contains `id`, `seller_id`, `buyer_id`, `quantity_kwh`, `price`, `payment`, `status`. An event contains `id`, `sequence`, `round`, `type`, `actor_id`, `counterparty_id`, `reason`, `reason_code`, `caused_by`, `trade` when relevant, and `trades_after` when reservations change. Extra fields are allowed. Private context must never be emitted in public messages. The manifest records protocol version and deterministic checksums.

## Task 1: Engine and invariant tests (Claude)

Files: collective_engine.py, tests/test_collective_engine.py. Claude writes only these files plus work/claude-engine-review.md and work/claude-engine-status.md.

- [x] Reconcile the independent review with this contract; report necessary changes before integration.
- [x] Write failing unittest cases with hand-checked fixtures for reserve, budget, bundle, cap, interval, atomic replacement, and repeated/limited state handling.
- [x] Implement deterministic world generation, explicit candidate moves, negotiation trace, paired comparison, and manifest.
- [x] Prove identical inputs yield identical traces and no-op changes yield zero changed trades.
- [x] Run `python -m unittest discover -s tests -p 'test_collective_engine.py' -v` and report evidence.

## Task 2: Policy parser and confirmation boundary (Codex)

Files: collective_policy.py, tests/test_collective_policy.py.

Interface: `parse_instruction(text: str, agent: dict) -> dict` returns `changes`, `recognized`, `errors`, `requires_confirmation`, `parser_version`. Never mutates the input profile. Supported seller phrase includes the exact 4 kWh / 2-4 PM / INR 7 / INR 6.50 if 3 kWh example. Buyers may set demand, budget, max price, and deadline.

- [x] Write failing tests for full conditional parsing, role mismatch, unsupported text, negative numbers, interval mismatch, and input immutability.
- [x] Implement strict grammar and semantic checks.
- [x] Run `python -m unittest discover -s tests -p 'test_collective_policy.py' -v`.

## Task 3: HTTP integration (Codex)

Files: collective_server.py, tests/test_collective_server.py, requirements-collective.txt.

Routes: GET `/`, GET `/assets/{name}`, GET `/healthz`, POST `/api/experiment`, POST `/api/policy`. Request bounds, strict finite numbers, same-origin checks, no shared visitor state. `/api/policy` generates the selected profile from a config and returns an unexecuted proposal. `/api/experiment` requires confirmation for custom intervention changes.

- [x] Write failing integration tests for actual paired results, unsupported fields, malformed/oversized inputs, cross-origin requests, and unconfirmed custom changes.
- [x] Implement isolated app with fixed assets and bounded simulations.
- [x] Run `python -m unittest discover -s tests -p 'test_collective_server.py' -v`.

## Task 4: Interactive workspace (Codex)

Files: web/index.html, web/collective.css, web/collective.js.

- [x] Implement the three-pane layout, seeded 50-agent initial baseline, real trace replay, graph selection/search/filter/zoom/pan, inspection, and timeline.
- [x] Add policy preview/diff/confirm/cancel, structured fallbacks, presets, and source memory inspection.
- [x] Add baseline/intervention comparison, causal chain, outcome charts, and JSON/JSONL/CSV exports.
- [x] Exercise supported flows in the browser at desktop and narrow widths, including a 100-agent run. Inspect reduced-motion CSS; keyboard and step controls remain available without animation.

## Task 5: Review and package (Codex with independent reviewer)

- [x] Run the complete available test suite and record any baseline dependency limitations.
- [x] Obtain an independent review of correctness and integration. Fix material findings with regression tests.
- [x] Save representative screenshots, a concise run guide, and a source ZIP under outputs/.
- [x] Leave the verified local preview open and report exact scope and remaining limitations.

## Added hosting scope

The user subsequently requested a public GitHub repository and a possible new Streamlit app. A session-local Streamlit adapter now hosts the same visual workspace through `deploy/collective/app.py`. The original application remains available. Public hosting awaits Streamlit sign-in.

Local verification: 99 Python tests, 17 JavaScript tests, 54 additional scenario cases, and browser checks of the Streamlit baseline, confirmed conditional policy, causal replay, comparison, and 100-household open market. See docs/evidence/verification.json.
