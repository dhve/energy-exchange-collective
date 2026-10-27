# Collective energy exchange sandbox

The collective workspace lets you change a household policy and inspect the resulting negotiations. It supports 20, 50, or 100 synthetic households, recorded replay, baseline comparison, agent inspection, and evidence exports.

[Open the hosted workspace](https://energy-exchange-collective.streamlit.app/).

## Run locally

Use Python 3.11 or newer. The collective workspace has no JavaScript build step, model API key, or NandaTown runtime dependency.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-collective.txt
.venv/bin/python -m src.energy_exchange.collective_server --port 8766
```

Open http://127.0.0.1:8766. The server binds to your computer by default. Stop it with Control-C in its terminal.

On macOS, you can run `./Start-Collective.command` instead. It creates the local Python environment and installs the collective dependencies when needed.

The original six-household Streamlit lab remains available through the original `requirements.txt` and `streamlit_app.py`. Its meter and settlement stages are separate from the collective negotiation workspace.

## Run or deploy with Streamlit

The Streamlit entry point uses the same HTML, CSS, JavaScript, engine, and parser. It sends requests through a session-local component bridge. Each request still passes the strict policy validation and the isolated 20-second worker.

```bash
.venv/bin/python -m pip install -r deploy/collective/requirements.txt
.venv/bin/python -m streamlit run deploy/collective/app.py --server.port 8767
```

Open http://127.0.0.1:8767. To host on Streamlit Community Cloud, sign in at https://share.streamlit.io and create an app with:

- Repository: `dhve/energy-exchange-collective`
- Branch: `main`
- Main file: `deploy/collective/app.py`
- Python: `3.12`
- Secrets: none

The requirements file beside the entry point keeps collective deployment independent of the legacy NandaTown dependency. Follow the [official Streamlit deployment steps](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/deploy). Deploying another copy requires signing into Streamlit and connecting the GitHub account that can deploy the repository. A Google sign-in to Streamlit alone does not connect GitHub.

## Try the demonstration

1. Keep 50 households, local discovery, and seed 42, then generate a baseline.
2. Keep household A17 selected and enter the instruction below.
3. Select **Preview policy**, check the proposed changes, and select **Confirm & renegotiate**.
4. Step through the event timeline or play the recorded events. Click a household to inspect its current reservations and latest decision.
5. Select **Compare** to see both networks at the same logical round. Scroll to Analysis for final allocation and utility differences.
6. Select an export button, then its **Download** link for the experiment JSON, event JSONL, or trade ledger CSV. The JSON contains both worlds, both runs, the exact changed fields, and reproducibility checksums. **View or copy** exposes the complete file if the browser cancels a download. Some downloads were cancelled by the Codex in-app browser during verification; the export text and the packaged examples were checked directly.

```text
Sell up to 4 kWh from 2–4 PM at at least ₹7/kWh; accept ₹6.50 only if at least 3 kWh is sold together.
```

Each intervention starts from the original baseline. Editing an instruction or experiment setting invalidates its previous confirmation preview. A failed request leaves the last successful result visible.

## Supported instructions

The parser uses an explicit grammar and rejects unsupported clauses. It does not use an LLM. The structured policy editor offers the same validation and confirmation flow.

| Purpose | Example |
| --- | --- |
| Seller price | Raise my minimum price to ₹9/kWh |
| Seller offer | Sell up to 4 kWh |
| Forecast | Set my surplus to 3 kWh |
| Reserve | Keep at least 1 kWh in reserve |
| Buyer price | Set my maximum price to INR 10 |
| Buyer budget | Set my budget to INR 25 |
| Buyer requirement | Buy 3 kWh |
| Deadline | Set my deadline to round 6 |
| Remove conditional floor | Remove my bundle discount |

Prices use the configured tick, INR 0.05 by default. Budgets use whole paise and energy inputs use whole watt-hours. The interface uses the fixed synthetic interval of 28 October 2026, 14:00 to 16:00 in Asia/Kolkata.

## What the model means

The protocol ranks feasible offers by the proposing agent's surplus. A new reservation can replace at most one trade from each participating agent in a single atomic transition. The proposing agent must improve its utility, and a responder that displaces a trade must also improve. A displaced third party can lose utility.

Prices follow a midpoint rule rounded to the configured tick. Conditional bundle discounts apply to one trade with one buyer. A household's utility is its price surplus times quantity. Shortfall, risk, and missed-requirement penalties are zero in this version.

"Locally stable" means the final search found no improving proposal within the declared bilateral move set and discovery graph. It does not establish a Nash equilibrium, a global optimum, or physical grid feasibility. Round limits, message limits, and cycles are reported separately. A valid final allocation can be committed even when negotiation stops at a limit.

The intervention clones the baseline's final allocation, applies confirmed changes, and revalidates reservations. If the baseline stopped before local stability, the comparison also includes any continued baseline negotiation. The interface displays that caveat.

Agent memory only breaks ties between feasible alternatives. The event trace records retrieved memory IDs. The inspector exposes synthetic private context for research inspection, but negotiation messages exclude private household text, reserves, budgets, and conditional policy fields.

The complete research export includes private synthetic profiles and before/after policy values. It is not a public message transcript. Changed kWh measures the volume of removed plus added trades, while the matched-energy difference measures the net allocation change.

All households, preferences, allocations, and payments are synthetic. No electricity or money is transferred. Discovery links describe permitted communication and do not describe electrical lines.

## Validation

Install the test dependency into the same environment and run the collective tests.

```bash
.venv/bin/python -m pip install httpx==0.28.1
.venv/bin/python -m unittest tests.test_collective_engine tests.test_collective_policy tests.test_collective_server -v
node --test tests/test_collective_ui.cjs tests/collective_streamlit_bridge.test.js
```

The engine tests use hand-checked fixtures for prices, budgets, reserves, bundle conditions, displacement, and baseline cloning. Scale checks cover all supported populations and discovery modes. The engine's `verify_result` function independently checks exported allocations and causal references. Browser regression tests execute the actual application script for confirmation and result handling.

The complete original and collective Python suite also needs the original `requirements.txt` dependencies. The checked build passed 99 Python tests and 17 JavaScript tests. The additional scenario matrix passed all 54 cases; see `docs/evidence/verification.json`.

The cycle detection path is implemented, but no tested generated world produced a cycle. The workspace provides energy-by-event and final utility charts. Configurable utility penalties, arbitrary time windows, live meters, settlement, and production deployment are outside this version.

## Implementation and attribution

The collective engine is a new implementation within the Energy Exchange Lab repository. It follows the existing lab's lifecycle and rounding patterns and NandaTown's event and evidence concepts. It does not import or claim to run NandaTown's runtime, negotiation layer, payment layer, or visualizer. The original lab remains the reference for its NandaTown runtime integration and settlement workflow.

Claude Fable 5.1 with Ultracode in the Claude desktop app handled the engine review and implementation. Codex handled policy parsing, the HTTP service, the visual workspace, integration, and verification. Source documents were treated as requirements material, not as permission to publish or contact anyone.
