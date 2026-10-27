"""Isolated HTTP workspace for synthetic collective energy experiments."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import uvicorn

WEB = Path(__file__).parent / 'web'


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Config(StrictModel):
    population: Literal[20, 50, 100] = 50
    seed: int = Field(default=42, ge=0, le=2147483647)
    topology: Literal['local', 'open'] = 'local'
    max_rounds: int = Field(default=12, ge=1, le=50)
    max_messages: int = Field(default=4000, ge=10, le=10000)
    utility_cap_kwh: float = Field(default=120, ge=0, le=1000)
    memory_enabled: bool = True
    price_tick: float = Field(default=0.05, gt=0, le=1)


class Bundle(StrictModel):
    floor: float = Field(ge=0, le=100)
    minimum_kwh: float = Field(gt=0, le=1000)


class Changes(StrictModel):
    min_price: float | None = Field(default=None, ge=0, le=100)
    max_price: float | None = Field(default=None, ge=0, le=100)
    budget: float | None = Field(default=None, ge=0, le=10000)
    max_offer_kwh: float | None = Field(default=None, ge=0, le=1000)
    forecast_surplus_kwh: float | None = Field(default=None, ge=0, le=1000)
    reserve_kwh: float | None = Field(default=None, ge=0, le=1000)
    demand_kwh: float | None = Field(default=None, ge=0, le=1000)
    conditional_price: Bundle | None = None
    deadline_round: int | None = Field(default=None, ge=1, le=50)
    interval_start: str | None = Field(default=None, max_length=50)
    interval_end: str | None = Field(default=None, max_length=50)

    @model_validator(mode='after')
    def no_null_numbers(self):
        for key in self.model_fields_set:
            if key != 'conditional_price' and getattr(self, key) is None:
                raise ValueError(f'{key} cannot be null')
        return self


class Intervention(StrictModel):
    agent_id: str = Field(default='A17', pattern=r'^A\d{2,3}$')
    scenario: Literal['custom', 'price', 'supply', 'budget', 'shock', 'none'] = 'custom'
    changes: Changes = Field(default_factory=Changes)
    confirmed: Literal[True]

    @field_validator('confirmed', mode='before')
    @classmethod
    def exact_confirmation(cls, value):
        if value is not True:
            raise ValueError('Explicit boolean confirmation is required')
        return value

    @model_validator(mode='after')
    def has_changes(self):
        if self.scenario == 'custom' and not self.changes.model_fields_set:
            raise ValueError('A custom intervention needs a confirmed policy change')
        return self


class ExperimentRequest(StrictModel):
    config: Config = Field(default_factory=Config)
    intervention: Intervention | None = None


class PolicyRequest(StrictModel):
    config: Config = Field(default_factory=Config)
    agent_id: str = Field(default='A17', pattern=r'^A\d{2,3}$')
    text: str = Field(min_length=1, max_length=2000)


async def worker(payload):
    process = await asyncio.create_subprocess_exec(
        sys.executable, '-m', 'src.energy_exchange.collective_server', '--worker',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), 20)
        if process.returncode:
            raise HTTPException(500, 'The simulation failed. Your previous result is unchanged.')
        result = json.loads(stdout)
        if '_error' in result:
            raise HTTPException(422, result['_error'])
        return result
    except TimeoutError:
        raise HTTPException(504, 'The bounded simulation timed out. Reduce rounds or use local discovery.') from None
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def create_app():
    app = FastAPI(title='Collective energy exchange', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.active = 0

    @app.middleware('http')
    async def boundary(request: Request, call_next):
        if request.method == 'POST':
            if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
                return JSONResponse(status_code=415, content={'detail': 'Send application/json'})
            expected = os.environ.get('ENERGY_PUBLIC_ORIGIN', str(request.base_url)).rstrip('/')
            if request.headers.get('origin', expected).rstrip('/') != expected:
                return JSONResponse(status_code=403, content={'detail': 'Use this application from its own host'})
            body = bytearray()
            async for part in request.stream():
                body.extend(part)
                if len(body) > 32768:
                    return JSONResponse(status_code=413, content={'detail': 'Request is too large'})
            request._body = bytes(body)
        response = await call_next(request)
        response.headers.update({
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        })
        return response

    @app.get('/')
    async def index():
        return FileResponse(WEB / 'index.html')

    @app.get('/healthz')
    async def health():
        return {'status': 'ok', 'mode': 'synthetic', 'llm': False}

    @app.get('/assets/{name}')
    @app.get('/{name}')
    async def assets(name: str):
        if name not in ('collective.js', 'collective.css', 'streamlit-bridge.js'):
            raise HTTPException(404)
        return FileResponse(WEB / name)

    async def bounded(payload):
        if app.state.active >= 2:
            raise HTTPException(429, 'The simulator is busy. Please retry shortly.')
        app.state.active += 1
        try:
            return await worker(payload)
        finally:
            app.state.active -= 1

    @app.post('/api/experiment')
    async def experiment(payload: ExperimentRequest):
        intervention = None
        if payload.intervention is not None:
            intervention = payload.intervention.model_dump(exclude={'confirmed', 'changes'})
            intervention['changes'] = payload.intervention.changes.model_dump(exclude_unset=True)
        return await bounded({'task': 'experiment', 'config': payload.config.model_dump(), 'intervention': intervention})

    @app.post('/api/policy')
    async def policy(payload: PolicyRequest):
        return await bounded({'task': 'policy', **payload.model_dump()})

    return app


def execute_worker():
    from .collective_engine import build_world, run_experiment
    from .collective_policy import PARSER_VERSION, parse_instruction
    raw = json.load(sys.stdin)
    try:
        if raw['task'] == 'policy':
            world = build_world(raw['config'])
            agent = next((a for a in world['agents'] if a['id'] == raw['agent_id']), None)
            if agent is None:
                raise ValueError('Select an agent in the current population')
            result = parse_instruction(raw['text'], agent, raw['config']['price_tick'])
            result['agent'] = agent
        else:
            result = run_experiment(raw['config'], raw.get('intervention'))
            result['manifest']['policy_interface'] = {
                'mode': 'deterministic_grammar', 'parser_version': PARSER_VERSION,
                'confirmation': 'Explicit confirmation is required for interventions',
            }
        print(json.dumps(result, allow_nan=False, separators=(',', ':')))
    except (ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'_error': str(exc)[:350]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    if args.worker:
        execute_worker()
    else:
        uvicorn.run(create_app(), host=args.host, port=args.port, access_log=False)


if __name__ == '__main__':
    main()
