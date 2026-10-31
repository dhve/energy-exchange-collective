# NandaTown implementation plan

Spec: ../specs/2026-10-31-nandatown.md

Execute inline with the executing-plans workflow. Read-only source and data investigations are complete.

## Global constraints

- Run the actual upstream Player. Preserve immutable source and license with a reproducible build.
- Show only recorded event terms and the applicable historical policy.
- Keep all negotiation messages through the replay prefix. Hover and keyboard focus highlight both participants.
- Preserve the simulation, translation, before/after comparison, and Streamlit transport.
- Do not publish chat exports, keys, or private caches.

## Task 1: source and adapter

Vendor the pinned Player source and node assets. Add a checked source extraction/build script and a React bridge to the existing JavaScript app. Write tests for event-to-flight mapping, stable agent colors, prefix visibility, historical policy sensitivity, and source integrity before implementing the adapter. Build the browser bundle with pinned dependencies. Commit source reuse and the pure adapter separately from the UI.

## Task 2: desktop interface

Add the Player mount and persistent negotiation history to the current page. Retain all messages, preserve scroll position, add follow-latest and keyboard focus, and render quantity/time sensitivities separately from messages. Synchronize the upstream clock with the existing replay cursor. Keep the agreement comparison available. Test these user behaviors and both HTTP/Streamlit asset paths. Commit the desktop integration.

## Task 3: verification and deployment

Run Python and JavaScript suites, inspect marketplace and auction upstream and the energy replay in a browser, verify desktop movement, hover, seeking, prompts, and reduced motion. Obtain a fresh whole-branch review and fix material findings. Publish logical commits, merge the PR preserving commits, and verify the live Streamlit app. Record exact source, build and validation in the repository.
