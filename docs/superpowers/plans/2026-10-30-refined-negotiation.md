# Refined Negotiation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Checkboxes track work.

**Goal:** Make the simple energy demo translate natural language and show real, auditable price bargaining and delivery windows.

**Architecture:** Extend the pure engine with bounded, recorded strategies and interval terms. Put all LLM calls and spending controls behind the existing server/Streamlit worker boundary. Keep the shared browser UI focused on a confirmed instruction and five-stage replay.

**Tech Stack:** Python 3.11+, standard library HTTP/SQLite, Pydantic/FastAPI, Streamlit component, vanilla JavaScript/SVG, unittest and node:test.

**Spec:** `docs/superpowers/specs/2026-10-30-refined-negotiation.md`

## Global Constraints

- Same original world and strategy plan for baseline and each single-household intervention.
- No invented energy quantities, prices or delivery deadlines in translation; explicit preview and confirmation.
- Credentials remain server-only; no credentials in code, browser payloads, logs, exports or screenshots.
- Recorded offers determine accepted terms; the UI never fabricates negotiation events.
- Energy is one flexible pool over a delivery window; no per-hour power or grid feasibility claim.
- Exact REP and Tata rules are not specified and must not be claimed as integrated.
- Public GitHub and existing Streamlit app; several logical commits.

## Review Focus

- Time-window changes must release incompatible carried agreements, including changed intervals at the same price/quantity.
- A smaller counteroffer must recheck conditional bundle price, reserve, budget and both participants' gains.
- Ambiguous mixed instructions must not partially apply an apparently valid clause.
- Cached LLM failure or concurrent requests must not change the baseline strategy or bypass paid-call limits.
- Replay must not show future agreements or lose controlled-household identity after inspecting another node.

### Task 1: Time-aware price bargaining

**Files:** `collective_engine.py`, new `collective_time.py` and/or `collective_bargaining.py`, engine tests (all under `src/energy_exchange` and `tests`).

**Interfaces:** `run_experiment(config, intervention=None, world=None, strategy_plan=None)`; config `negotiation_mode` is `midpoint` or `bargaining`, default pure-engine `midpoint`. Server will default to `bargaining`. Agent optional `time_price` is `{after: ISO timestamp, floor: INR/kWh}`. Plan `{version, source, agents: {id: {price_positions: [integer basis points]}}}`; buyer positions increase, seller positions decrease, all 0..10000, three positions. No fixed final position is imposed; a bounded session may end without agreement. Engine validates/fingerprints plan. Trade/event `delivery_start` and `delivery_end` are ISO timestamps. Engine returns the normalized plan in the manifest. Default rule plans remain available without network.

- [x] Write and observe failing tests for partial/no overlap, late price flexibility, real price counteroffers, different valid strategies producing different realized prices, limits, no-op/one-household invariance, smaller bundle counteroffers and tampered replay.
- [x] Implement interval parsing/overlap/segments and actual bounded price exchanges; preserve legacy mode and snapshots.
- [x] Add accepted-terms validation and provenance, repair/hashes/comparison/replay support, gains/losses metrics.
- [x] Run all Python tests, inspect failures and commit engine changes independently.

### Task 2: Low-cost translation and strategy service

**Files:** new `collective_llm.py`, existing `collective_policy.py`, `collective_server.py`, `collective_streamlit.py`, associated tests, deployment configuration examples.

**Interfaces:** `translate_instruction(text, agent, price_tick) -> dict` preserves `changes`, `recognized`, `errors`, `requires_confirmation`; adds `normalized_prompt`, `clarification_questions`, `assumptions`, `translation` metadata. `prepare_strategy_plan(world) -> dict` returns Task 1's plan plus server provenance. `get_llm_status()` contains availability/model only, never key. `OPENAI_API_KEY` and `ENERGY_LLM_MODEL` are server settings. Policy validation still occurs independently of the model.

- [x] Write and observe failing tests for messy explicit instructions, ambiguous party/EV requests, invalid model output, mixed unsupported clauses, time interpretation, secret-safe errors, cache reuse, parallel/daily call limits and fallback.
- [x] Implement strict Responses API adapter, validated JSON schemas, deterministic grammar fast path and bounded server cache/usage ledger.
- [x] Integrate worker, Streamlit secrets and server config. Freeze/reuse plans; avoid model calls in replay.
- [x] Run automated tests and a small live model evaluation; choose cheapest passing model and record usage. Commit service and integration separately if useful.

### Task 3: Clear negotiation replay

**Files:** `web/index.html`, `web/collective.js`, `web/collective.css`, UI tests.

**Interfaces:** Task 2 policy fields render only in preview; submitted intervention contains only supported agent/scenario/changes/confirmed fields. Task 1 time terms and strategy provenance are optional for backward compatibility. Existing events remain authoritative.

- [x] Write and observe failing UI tests for clarification blocking apply, stale preview, five real replay stages, directed message/agreement distinction and controlled/inspected identity.
- [x] Add a short conversation panel tied to active agents, five stage controls, clear line legend/arrows, visible home IDs, window and flexibility summaries, optional method comparison and gains/losses.
- [x] Keep prompt + visualization primary, details closed, accessible desktop and mobile. No fixed count of fabricated exchanges.
- [x] Run JS suite, browser checks and commit UI changes independently.

### Task 4: Review and publish

**Files:** README-COLLECTIVE, design/plan progress, deployment docs and evidence; output archive/manifest/screenshots.

- [x] Run full Python/JS suite and representative engine matrix, record invariants and real LLM evaluation.
- [x] Review independently with Claude Fable and a fresh code reviewer; fix important findings with regression tests.
- [x] Configure server-only deployment secret, push logical commits, verify CI and hosted prompt/clarification/negotiation on desktop and mobile.
- [x] Refresh source archive, manifest and concise run guide; save hosted proof screenshot and report remaining material limitations.

Release verification: 155 Python tests, 54 JavaScript tests, 24 scenario cases and seven live translation cases passed. The public Streamlit export from engine 0.2.1 passed offline checksum and deterministic replay verification with an LLM strategy plan. GitHub Actions passed on Python 3.11, 3.12 and 3.14, plus the legacy app. Final evidence is in `docs/evidence/verification.json`.
