# Collective energy exchange sandbox

The workspace lets you change one synthetic home's requirements and follow the resulting negotiation. It starts with 50 homes in five neighbourhoods, with Yash's home, A17, under your control. Selecting another home opens its details without changing control. Research settings also support 20 or 100 homes and local or open discovery.

[Open the hosted workspace](https://energy-exchange-collective.streamlit.app/).

## Try the demonstration

1. Choose an example or write a requirement in the instruction box. Examples fill the box without applying a change.
2. Select **Review my change** and check the proposed rules. Answer any clarification before continuing.
3. Select **Apply and see the result** to confirm the change.
4. Play the replay or select a stage. The stages show starting agreements, the revised requirement, the directly affected agreement, offers and responses, and the final allocation.
5. Open household details or detailed results to inspect decisions, compare outcomes, and download records.

```text
Sell up to 4 kWh from 2 to 4 PM at at least ₹7/kWh; accept ₹6.50 only if at least 3 kWh is sold together.
```

Replay uses recorded events, including actual offers, counteroffers, acceptances, rejections, and replacements. When a stage has no corresponding event, the workspace says so. Communication arrows show who contacted whom, while energy agreements show accepted trades.

Every intervention starts from the original baseline and uses the same frozen household strategies. A second instruction replaces the previous intervention. Editing an instruction or experiment setting invalidates its previous confirmation. A failed request leaves the last successful result visible.

## Run locally

Use Python 3.11 or newer. The workspace has no JavaScript build step or NandaTown runtime dependency.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-collective.txt
.venv/bin/python -m src.energy_exchange.collective_server --port 8766
```

Open http://127.0.0.1:8766. The server binds to your computer by default. Stop it with Control-C in its terminal. On macOS, `./Start-Collective.command` creates the environment and installs dependencies when needed.

The workspace runs without an API key using rules-based translation and bargaining fallback. To enable model assistance, set `OPENAI_API_KEY` in the server environment. `ENERGY_LLM_MODEL` defaults to `gpt-6-luna`, the currently supported model. Keep credentials on the server and never commit them or send them to the browser.

## Run or deploy with Streamlit

The Streamlit entry point uses the same workspace and engine through a session-local component bridge.

```bash
.venv/bin/python -m pip install -r deploy/collective/requirements.txt
.venv/bin/python -m streamlit run deploy/collective/app.py --server.port 8767
```

Open http://127.0.0.1:8767. For Streamlit Community Cloud, create an app with these settings:

| Setting | Value |
| --- | --- |
| Repository | `dhve/energy-exchange-collective` |
| Branch | `main` |
| Main file | `deploy/collective/app.py` |
| Python | `3.12` |
| Secrets | Optional server configuration shown below |

Add `OPENAI_API_KEY` and `ENERGY_LLM_MODEL` through Streamlit's Secrets settings to enable model assistance. [The example file](deploy/collective/secrets.example.toml) contains placeholders only. Never commit an actual key. Without a key, the app reports its fallback method.

The requirements file beside the entry point keeps deployment independent of the legacy NandaTown dependency. Follow the [official Streamlit deployment steps](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/deploy). Deploying a copy requires a connected GitHub account with access to the repository.

## Instructions and delivery windows

Clear supported instructions use an explicit grammar without a paid model call. For other wording, the server can use OpenAI's Responses API with strict Structured Outputs to propose a validated policy. Ambiguous parties, EV energy quantities, or delivery times produce questions. No model proposal applies without confirmation. The structured policy editor uses the same validation and confirmation.

| Purpose | Example |
| --- | --- |
| Seller price | Raise my minimum price to ₹9/kWh |
| Seller offer | Sell up to 4 kWh |
| Forecast | Set my surplus to 3 kWh |
| Reserve | Keep 1 kWh in reserve |
| Buyer price | Set my maximum price to INR 10 |
| Buyer budget | Set my budget to INR 25 |
| Buyer requirement | Buy 3 kWh |
| Deadline | Set my deadline to round 6 |
| Remove conditional floor | Remove my bundle discount |

Prices use the configured tick, INR 0.05 by default. Budgets use whole paise and energy inputs use whole watt-hours. Delivery windows use the fixed synthetic day of 28 October 2026 in Asia/Kolkata. Negotiation rounds are separate from delivery time.

Partially overlapping windows can trade within their overlap. Windows that only touch cannot trade. Sellers can specify a lower price floor after a delivery time, and accepted trades record their delivery interval. Each home has one flexible total energy pool over its window. There is no hourly availability, power, or device capacity model.

## Bargaining and comparisons

Bargaining is the default method. The model chooses a firm, balanced, flexible, or urgent strategy for each household from a validated catalog for buyers and sellers. Each choice maps to three price positions that the engine uses for offers and concessions. Model plans are cached, and their source, model, versions, usage, and provenance are recorded. The service records the catalog, and the exported plan records each household's choice. A rules-based fallback is disclosed when the model is unavailable. Plans, including fallback plans, stay frozen for each generated world and its interventions.

The engine ranks feasible proposals by the proposing home's surplus. One atomic replacement can remove at most one agreement from each participating home. The proposer must improve its utility, and a responder that displaces an agreement must also improve. A displaced third party can lose utility. Bundle discounts apply to one trade with one buyer. Utility is price surplus times quantity, with no shortfall, risk, or missed-requirement penalties.

The midpoint comparison method uses the middle of the feasible price range, rounded to the price tick. The comparison runs both methods on the same household profiles, delivery windows, and intervention. Each method forms its own starting allocation. The table reports actual traded energy, unmet demand, payments, and message counts, without claiming that either method always performs better.

"Locally stable" means no further improving move was found under the recorded strategy, discovery graph, and bounded bilateral move set. It does not establish a Nash equilibrium or global optimum. Round limits, message limits, and cycles are reported separately. A valid allocation can be committed when negotiation stops at a limit.

An intervention starts with the baseline's final allocation, then revalidates agreements against the confirmed change. If the baseline stopped before local stability, the result may include further negotiation that the baseline had not completed. The workspace displays that caveat.

## Model use and cost controls

User instructions may be sent to OpenAI for translation. Synthetic household context may be sent to prepare bargaining plans. Replay and inspection make no paid calls. Requests use no model tools and set `store: false`. Translation output is limited to 1,800 tokens, and strategy output to 3,000 tokens.

The default model is `gpt-6-luna`. Its [official Standard rates](https://developers.openai.com/api/docs/models/gpt-6-luna) were $0.10 per million input tokens and $0.50 per million output tokens on 30 October 2026. Actual charges depend on token use and current API pricing.

A SQLite cache with a file lock shares cached results and call limits across workers on one host. The default limit is 100 paid-call attempts per UTC day and 10 per minute. Cache hits use no paid attempt, while failed requests consume an attempt. `ENERGY_LLM_DAILY_CALLS` sets the daily limit, and `ENERGY_LLM_CACHE` sets the cache path.

The limits are a cost guard for one host, not an account billing cap. Multiple hosts have separate limits. An ephemeral disk can lose its cache and counters on restart or redeploy. Set account-level controls separately when needed. API requests time out after 22 seconds, workers after 60 seconds, and Streamlit bridge requests after 75 seconds.

## Evidence, exports, and limits

Detailed results include household gains and losses, event traces, and trade ledgers. Agent memory only breaks ties between feasible alternatives, and traces record retrieved memory IDs. The inspector exposes private synthetic context for research, while negotiation messages exclude private household text, reserves, budgets, and conditional policy fields.

Complete research exports include private synthetic profiles, policy changes, and strategy provenance. Changed kWh counts removed plus added trades, while matched-energy difference measures the net change. Exports contain no API credentials.

Run the collective checks after installing the test dependency:

```bash
.venv/bin/python -m pip install httpx==0.28.1
.venv/bin/python -m unittest tests.test_collective_engine tests.test_collective_policy tests.test_collective_server tests.test_collective_llm tests.test_collective_bargaining tests.test_collective_streamlit -v
node --test tests/test_collective_ui.cjs tests/collective_streamlit_bridge.test.js
```

Tests cover constraints, delivery overlap, bargaining, confirmation, fallback, cost guards, and result handling. The engine's `verify_result` function independently checks allocations and causal references. The complete original and collective Python suite also needs the original `requirements.txt` dependencies. See [verification evidence](docs/evidence) for checked runs and the scenario matrix.

All homes, preferences, allocations, and payment totals are synthetic. No electricity or money is transferred. Discovery links describe permitted communication, not electrical lines. The collective workspace has no physical flow model, live meters, live weather, payment settlement, or REP or Tata market integration.

## Implementation and attribution

The collective engine follows the original Energy Exchange Lab's lifecycle and rounding patterns, along with NandaTown's event and evidence concepts. It does not import NandaTown's runtime. The [original six-household lab](README-LEGACY.md) remains available through `requirements.txt` and `streamlit_app.py`, including its separate meter and settlement workflow.

Claude Fable 5.1 with Ultracode reviewed the source PDF and engine. The Codex team implemented the refined negotiation flow, policy interface, services, visual workspace, integration, and verification.
