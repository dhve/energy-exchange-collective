"""Session-local Streamlit transport for the shared collective workspace.

The existing request models and 20-second subprocess worker remain the trust
boundary. This module neither evaluates browser code nor starts a web server.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Literal

from fastapi import HTTPException
from pydantic import Field, ValidationError

from .collective_server import (
    WEB, ExperimentRequest, PolicyRequest, StrictModel, worker,
)


class BridgeRequest(StrictModel):
    id: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    path: Literal['/api/experiment', '/api/policy']
    payload: dict


def handle_request(raw, session):
    """Return (response, changed); repeated renders never repeat a worker.

    ``session`` belongs to one Streamlit session. Only the latest response is
    kept; completed IDs prevent stale requests from executing again.
    """
    if raw is None:
        return session.get('response'), False
    request_id = raw.get('id') if isinstance(raw, dict) else None
    if not isinstance(request_id, str):
        request_id = ''
    request_id = request_id[:100]
    try:
        encoded = json.dumps(raw, allow_nan=False, sort_keys=True, separators=(',', ':')).encode()
    except (TypeError, ValueError):
        encoded = b'non-json-request'
    fingerprint = hashlib.sha256(encoded).hexdigest()
    if session.get('last_fingerprint') == fingerprint:
        return session.get('response'), False
    response = {'id': request_id, 'status': 200, 'body': {}}
    try:
        if encoded == b'non-json-request':
            raise HTTPException(422, 'Send finite JSON values only')
        if len(encoded) > 32768:
            raise HTTPException(413, 'Request is too large')
        request = BridgeRequest.model_validate(raw)
        if request.id in session.get('processed_ids', set()):
            raise HTTPException(409, 'This request ID was already processed; preview again')
        if request.path == '/api/policy':
            policy = PolicyRequest.model_validate(request.payload)
            payload = {'task': 'policy', **policy.model_dump()}
        else:
            experiment = ExperimentRequest.model_validate(request.payload)
            intervention = None
            if experiment.intervention is not None:
                intervention = experiment.intervention.model_dump(exclude={'confirmed', 'changes'})
                intervention['changes'] = experiment.intervention.changes.model_dump(exclude_unset=True)
            payload = {'task': 'experiment', 'config': experiment.config.model_dump(),
                       'intervention': intervention}
        # A Streamlit script thread has no running asyncio loop. Reuse the same
        # isolated worker, termination deadline, and error mapping as FastAPI.
        response['body'] = asyncio.run(worker(payload))
    except ValidationError as exc:
        response.update(status=422, body={'detail': [
            {'loc': list(error['loc']), 'msg': error['msg']} for error in exc.errors()
        ]})
    except HTTPException as exc:
        response.update(status=exc.status_code, body={'detail': exc.detail})
    except Exception:
        response.update(status=500, body={'detail': 'The simulation failed. Your previous result is unchanged.'})
    session.setdefault('processed_ids', set()).add(request_id)
    session['last_fingerprint'] = fingerprint
    session['response'] = response
    return response, True


def main():
    import streamlit as st
    import streamlit.components.v1 as components

    st.set_page_config(page_title='Collective energy exchange | NANDA',
                       page_icon='☀', layout='wide', initial_sidebar_state='collapsed')
    st.html('''<style>
      [data-testid="stHeader"], [data-testid="stToolbar"] {display:none;}
      [data-testid="stMainBlockContainer"] {padding:0;max-width:none;}
      [data-testid="stMain"] {padding:0;}
      [data-testid="stCustomComponentV1"] {width:100%;}
    </style>''')
    component = components.declare_component('collective_workspace', path=str(WEB))
    session = st.session_state.setdefault('collective_transport', {})
    request = component(response=session.get('response'), key='collective_workspace', default=None)
    _, changed = handle_request(request, session)
    if changed:
        st.rerun()


if __name__ == '__main__':
    main()
