# Refined demo review

The 30 October 2026 update implements the supplied discussion's main demonstration requirements. The source PDF was treated as requirements material and is not included in the public repository.

| Requirement | Implemented behavior |
| --- | --- |
| Change one home through chat | A17 is clearly identified as the controlled home. A proposed change requires confirmation. Inspecting another home does not change control. |
| Translate rough instructions | Supported grammar is free. Other wording uses validated model output. Missing energy amounts, units or times require clarification. |
| Show consequential bargaining | Frozen model-selected strategies guide actual offers, counteroffers and accepted prices. Every displayed exchange comes from a recorded engine event. |
| Represent delivery time and flexibility | Trades use overlapping delivery windows. A seller can lower its floor after a stated time. Energy remains one flexible total pool per home. |
| Explain the response clearly | Five replay stages show the original agreements, revised policy, direct repair, an actual exchange and final allocation. Missing effects are stated explicitly. |
| Keep the network understandable | Five fixed clusters, household IDs, controlled-home marker, direction arrows, and separate message and agreement styles. Detailed tools start closed. |
| Compare effects fairly | Each intervention reuses the original world and strategy plan. Optional tables compare bargaining with midpoint matching and show household gains and losses. |
| Preserve evidence | Exports include delivery terms, strategy provenance, recorded events and checksums. Verification replays decisions without model calls. |

Claude Fable 5.1 with Ultracode in the desktop app reviewed the PDF and engine approach. A separate code review covered the engine, UI and model boundary. Reported issues with replay chronology, original-policy display, dropped conditions, numeric units and frozen-cache behavior were corrected with regression tests. The catalog planner also passed a focused independent review.

Hosted export verification exposed a numeric serialization issue: browsers write integral values such as `1.0` as `1`. Versioned numeric checksums now preserve verification across that conversion. Regression checks retain detection of altered prices and quantities. Replaying the same hosted world and frozen plan produced identical trade ledgers after the correction.

Tata's final market rules, a specific REP protocol, household role switching, live forecasts, device power limits, physical delivery and payment settlement remain outside the implemented scope. The supplied discussion leaves those definitions open. The app describes itself as a synthetic negotiation demonstration and does not claim a global optimum.

See `verification.json`, the test logs and exported experiments in this directory for release checks.
