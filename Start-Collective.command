#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import fastapi, pydantic, uvicorn' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements-collective.txt
fi
print 'Open http://127.0.0.1:8766 to use the collective energy sandbox.'
print 'Stop the server with Control-C.'
exec .venv/bin/python -m src.energy_exchange.collective_server --port 8766
