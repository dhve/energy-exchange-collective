# Simple workspace implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement the tasks in order.

**Goal:** Make the prompt and simulation the clear starting point for a non-technical visitor.

**Architecture:** Keep the existing shared HTML/CSS/JavaScript application and Python services. Move optional tools into native disclosures and add plain-language guidance derived from the existing simulation result.

**Tech stack:** HTML, CSS, JavaScript, Python, FastAPI, Streamlit.

**Spec:** `docs/superpowers/specs/2026-10-27-simple-workspace-design.md`

## Global constraints

- Preserve the simulation, confirmation requirement, and exports.
- Suggestions fill the prompt without executing a policy.
- Use 18 px body text and controls at least 44 px high.
- Keep the synthetic-data explanation visible.

## Review focus

- Switching between a buyer and seller must update example instructions.
- Editing a pending or confirmed preview must invalidate it.
- Empty and unsupported instructions must give an actionable response.
- Limited runs must not claim equilibrium or a completed market search.
- Narrow screens and keyboard users must reach the prompt, graph, and optional tools.

### Task 1: Focus the layout

**Files:** `src/energy_exchange/web/index.html`, `collective.css`.

**Interfaces:** Preserve all existing IDs consumed by `collective.js`. Add `run-view`, `simple-outcome`, `prompt-help`, `household-details`, and three `example-N` buttons.

- [ ] Build the prompt and graph layout, with closed disclosures for optional tools.
- [ ] Check retained IDs, keyboard order, narrow and desktop layouts in the browser.
- [ ] Commit the layout as a focused change.

### Task 2: Guide the interaction

**Files:** `src/energy_exchange/web/collective.js`, `tests/test_collective_ui.cjs`.

**Interfaces:** `suggestedInstructions(agent)` returns three `{label,text}` entries. `useExample(index)` fills the current role's instruction and clears a draft without making an API request. `renderOutcome()` derives its visible summary from the completed paired results.

- [ ] Add failing tests for role-aware examples, stale-preview invalidation, result direction, and truthful limits.
- [ ] Add guidance and simplify the review, status, and playback wording.
- [ ] Run the JavaScript suite and commit the interaction changes.

### Task 3: Verify and publish

**Files:** README/run guide, screenshots, verification evidence.

- [ ] Review Claude's independent usability findings and the final diff.
- [ ] Verify the sample instruction, rejected instructions, replay, comparison, optional settings, and exports locally in both hosts.
- [ ] Run all Python and JavaScript tests.
- [ ] Publish focused commits, check GitHub CI and the hosted app, then update the downloadable source bundle.
