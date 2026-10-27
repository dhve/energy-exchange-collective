# Collective energy sandbox design

The requested deliverable is an executable research sandbox based on the supplied collective negotiation specification. The attachment supplies requirements and does not authorize messages, deployments, or changes to other projects. The initial deliverable is a working local preview and a reproducible source package. The public lab and its legacy simulation remain intact.

## Approach

Extend the Python project with an isolated collective engine and a dedicated FastAPI web entry point. Use a small browser application with SVG network graphics and no build dependency. Reuse the existing lab's separation of proposals, reservations, commitments, and settlement. Inspect NandaTown messaging APIs before claiming runtime integration. Keep attribution and distinguish conceptual reuse from imported runtime code.

Keeping the entire UI in Streamlit would simplify deployment but restrict synchronized inspection, graph navigation, and chat. Replacing Python with a browser-only engine would duplicate the existing scientific foundation. A Python engine and dedicated web workspace are the working choice.

## Defaults and scope

- Population 20, 50, or 100; default 50. Default seed 42.
- One synthetic future interval, 2026-10-28 14:00 to 16:00 in Asia/Kolkata. No real electricity or payments.
- Local bounded discovery by default, with an open discovery comparison.
- Maximum 12 rounds by default; bounded messages, explicit termination, and allocation invariant checks.
- Integer or decimal-safe money and energy calculations. A price tick of INR 0.05/kWh.
- Atomic changes to provisional allocations; immutable baseline and exogenous inputs.
- Conditional price floors apply to each qualifying bundle. Soft memory preferences cannot alter hard limits.
- Natural-language parsing supports a documented grammar, with a preview and confirmation. Ambiguous or unsupported conditions produce errors instead of partial execution.
- Public messages exclude synthetic private household context. The inspector labels private research context.

The implemented move set allows fills and at most one released trade per participant in a bilateral replacement. Utility is price surplus times quantity, with risk and shortfall penalties set to zero. The application and manifest disclose the exact search and stability scope.

## Workspace

The left pane controls the user's agent, policy instructions, parsed changes, and confirmation. The center contains the stable network layout and replay controls. The right pane shows the selected agent, its constraints, memory sources, and decisions. The lower analysis area compares quantities, costs, affected agents, cascade depth, and exact resolution status.

Every node, edge, event, and metric is derived from the engine response. Selection, filtering, stepping, and exports remain available without animation. The interface supports keyboard navigation and reduced motion. At 100 agents the display suppresses unselected node labels while preserving active trade edges and accessible agent selection.

## Boundaries

Claude owns the pure engine and its tests. Codex owns the policy parser, HTTP boundary, visual workspace, integration tests, and packaging. Both use an explicit JSON contract in the implementation plan. No parallel edits to shared files.

Optional model-based parsing, live data, power flow, and actual settlement are excluded. The existing lab remains the separate meter-supported settlement reference.

## Evidence required

Tests must establish reproducibility, no double reservations, budgets, seller reserves, price/bundle rules, cap enforcement, interval compatibility, baseline immutability, honest limit status, causal references, and private-message boundaries. Browser checks must exercise the policy preview/confirm flow, playback, agent inspection, baseline comparison, exports, and a 100-agent run.
