# Simple energy sharing workspace

The user requested a landing page centred on a prompt and the simulation, suitable for a non-technical audience. The first task should be clear without understanding market research terms.

## Approach

Use two primary panels: an instruction card and the neighbourhood visualization. Keep configuration, household inspection, research results, and exports in closed disclosures. A separate beginner page would duplicate the interface; deleting the detailed tools would remove useful capabilities. Progressive disclosure preserves the shared FastAPI and Streamlit interface.

The instruction card has a visible label, a short example, three role-appropriate suggestions, and a review button. Applying a change remains a separate explicit confirmation. The graph has a clearly labelled replay button, readable legend, and a short result summary. Before, after, and comparison controls appear after a successful change.

Use 18 px body text, strong contrast, visible keyboard focus, and controls at least 44 px high. On narrow screens the prompt comes first, followed immediately by the graph. Comparison graphs stack on narrow screens. Keep the synthetic-data explanation visible and use ordinary words for the primary actions.

## Constraints

Preserve deterministic parsing, confirmation invalidation, engine results, exports, and replay. Keep unsupported-instruction errors visible beside the prompt. A suggested instruction only fills the text box. It never applies a policy. A household choice must update the suggestions to its buyer or seller role. Detailed results must remain available without resetting the current experiment.

No engine, API, dependency, or hosting changes are required. Continue publishing focused commits to the existing public repository and Streamlit app.
