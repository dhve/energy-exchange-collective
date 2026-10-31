# NandaTown replay verification

The desktop workspace uses the actual marketplace/auction React/D3 Player from projnanda/nandatown, commit `b7adc6121868742cf0f00cfebbf2d38bdb349057`. Original source and artwork checksums are in `frontend/vendor/nandatown/provenance.json`. The build verifies those files before applying the documented energy integration hooks.

## Automated checks

- 165 Python tests passed on the implementation. The targeted 8 Streamlit transport and asset tests passed after the asset-route checks were extended.
- 80 JavaScript tests passed, including the actual bundled Player's automatic completion, new-run cursor isolation, persistent history, historical policy eligibility, comparison replay, and focus highlighting.
- The original Player completion and new-run clock cases were reproduced as failing tests before correction.
- A repeat browser build produced the same committed assets. CI also rebuilds and compares the generated files.
- The dependency audit reported no vulnerabilities.

## Browser checks

The upstream live marketplace and auction were inspected. The energy workspace was checked in both FastAPI and Streamlit. The Streamlit iframe rendered all 50 homes and the local NandaTown node artwork. The desktop canvas fit every home without clipping. Playback advanced recorded events, the negotiation history remained scrollable, and the price instruction "Make the minimum price 3.5" produced a reviewable ₹3.50/kWh change through both hosts.

## Review

An independent source review identified comparison playback, missing-term eligibility, and highlighting in agreement maps. All material findings were fixed. The bundled Player tests also reproduced and fixed final-frame and run-switch ordering defects. A browser check found that mouse exit could clear a keyboard highlight, which was fixed with a focused regression test.

Replay is a visual presentation of recorded events. It does not represent actual network latency or electricity delivery, invent messages for ledger bookkeeping, or make LLM calls during playback.
