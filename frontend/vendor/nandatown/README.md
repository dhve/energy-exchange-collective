# NandaTown source

Source: https://github.com/projnanda/nandatown/tree/b7adc6121868742cf0f00cfebbf2d38bdb349057

The original `apps/nest-dashboard/src/app/visualizer/page.tsx`, global stylesheet, node images, and Apache 2.0 license are copied without modification. `provenance.json` records SHA-256 checksums. There was no upstream NOTICE file at this commit.

The marketplace and auction use the same React/D3 `Player`. `frontend/build.mjs` verifies every original file and extracts lines 13 to 1758, replacing the Next.js page wrapper with the energy app bridge. The generated module retains the actual upstream force layout, message trails, ripples, drag, zoom, and animation clock. It is not a separately implemented lookalike.

Adaptations made on 2026-10-31 are explicit, unique-match patches in the build script. They add energy selection and hover hooks, per-home rings and labels, keyboard selection, a camera fit for off-canvas nodes, reduced-motion handling, an agreement overlay, and relative image URLs. The energy interface hides duplicate upstream transport controls, counters, and whole-run tooltips. The original source remains unchanged for comparison. Replay duration is scaled by the bridge; replay time is not electricity delivery time.

Build with `npm ci` and `npm run build` at the repository root. React, D3, esbuild, and Tailwind versions are locked. The generated browser files are committed because Streamlit serves them without a Node runtime. CI rebuilds and checks for a clean diff. No CDN is used.

`energy-replay.js` maps existing recorded energy events to the Player. Only offers, counteroffers, acceptances, and rejections produce animated message flights. The permanent history also includes recorded agreement outcomes. Private price rules appear under a separate policy-context disclosure and are not represented as dialogue sent to another home.
