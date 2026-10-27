# Collective Energy Exchange

A working visual sandbox for studying how one household policy changes negotiations across a synthetic energy market. Built on [Energy Exchange Lab](https://github.com/dhruvsarkar/energy-exchange-lab), with a new deterministic collective engine and interactive workspace.

[Open the hosted workspace](https://energy-exchange-collective.streamlit.app/).

![Collective energy exchange workspace](docs/assets/collective-workspace.jpg)

## Run locally

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-collective.txt
.venv/bin/python -m src.energy_exchange.collective_server --port 8766
```

Open **http://127.0.0.1:8766**. On macOS, `./Start-Collective.command` sets up the environment and starts the server.

## Explore

- Generate 20, 50, or 100 synthetic households with local or open discovery.
- Preview a policy, inspect its exact changes, and confirm renegotiation against an unchanged baseline.
- Replay actual offers, counteroffers, reservations, and atomic replacements. Select households, inspect decisions and memory, and follow causal events.
- Compare allocations, utilities, message counts, and termination conditions.
- Export complete experiments, event traces, and trade ledgers as JSON, JSONL, and CSV.

Try this with the default 50 households, seed 42, and agent A17:

> Sell up to 4 kWh from 2–4 PM at at least ₹7/kWh; accept ₹6.50 only if at least 3 kWh is sold together.

The checked example changes matched energy from **50.10 to 51.15 kWh**, affects **four households**, and records **28 intervention events**. Its complete evidence is in [docs/evidence](docs/evidence).

## Streamlit hosting

The [public Streamlit app](https://energy-exchange-collective.streamlit.app/) runs `deploy/collective/app.py` from this repository's `main` branch with Python 3.12. It hosts the same visual workspace as the local server. See [the run guide](README-COLLECTIVE.md) for deployment and local commands.

## Validation and scope

[The run guide](README-COLLECTIVE.md) explains the protocol, exact stability claim, supported policy grammar, validation commands, export behavior, and limitations. Verification evidence and the scenario matrix are in [docs/evidence](docs/evidence). GitHub Actions runs the collective and legacy checks.

All households and trades are synthetic. The engine enforces budgets, reserves, price and bundle rules, time compatibility, and a shared trading cap. A locally stable result refers to the disclosed bounded bilateral move set. It does not establish a Nash equilibrium, a global optimum, or physical grid feasibility.

The collective engine uses NandaTown concepts but does not import its runtime. The [original six-household lab](README-LEGACY.md), including its NandaTown integration and meter-supported settlement, remains available through `streamlit_app.py`.

Claude Fable 5.1 with Ultracode in the Claude desktop app handled engine implementation and review. Codex handled the policy interface, visual workspace, services, integration, and verification.
