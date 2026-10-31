# Refined energy exchange demo

## Intent and sources

Implement the mentor clarification and technical recommendations in the supplied `energy_exchange_refined_discussion.pdf`, with the user's addition of an inexpensive LLM for prompt translation and consequential price bargaining. The attachment is requirements evidence, not permission to perform unrelated actions. Preserve the simple prompt and network layout for nontechnical visitors.

## Experience

Fifty synthetic households in five fixed neighbourhoods start with an allocation. A visitor controls one clearly named household. Clicking a different node inspects it without changing control. A rough instruction is translated into an explicit policy preview. Ambiguous quantities, units or deadlines produce a clarification, never an invented requirement. Only confirmation applies the change. All comparisons use the same original world and frozen negotiation strategies; other household policies remain unchanged.

Replay presents five stages: starting agreements, revised requirement, directly affected agreement, offers and responses, final allocation. Stages group recorded events; missing effects are described honestly. The main graph distinguishes directional communication from energy agreements, identifies active parties, and shows readable short offers and reasons. Detailed traces, private synthetic preferences, parameters and downloads remain optional.

## Negotiation and time

Keep the existing midpoint engine as a comparison mode. The main app uses bounded bilateral bargaining. A server-side LLM prepares a strictly validated strategy for each synthetic household; the same plan is cached and frozen for baseline and interventions. Strategies choose price aspirations and concessions. The executable engine sends real offers, counteroffers, acceptances and rejections based on current availability, budgets and recorded plans. No generated dialogue invents events. Label the method as LLM-planned bargaining, with rules-based fallback when unavailable.

Delivery windows are timezone-aware intervals on a fixed synthetic day. Partially overlapping windows can trade only within the overlap; touching windows cannot. A seller can state a lower minimum price after a specified delivery time. The engine may offer the later segment at that floor. Negotiation rounds are separate from delivery time.

Energy is a single flexible pool per household over its declared window. Scheduling within that window is unconstrained by power, devices or forecasts per hour. This assumption is disclosed; do not invent per-hour availability or imply grid feasibility. Every accepted trade includes its delivery interval. Total energy, reserve, buyer demand, budget, price tick, price floor/ceiling, overlap, bundle rules, discovery edges and permitted replacements are enforced after counteroffers and in replay checks. Rejection caching, hashes, repair and comparison include delivery terms and strategy identity where relevant.

Termination means no further admissible move under the recorded strategy and bounded move set. It does not mean global optimum, Nash equilibrium, physical delivery or settled payments. Limited baselines retain the continued-negotiation caveat. Report unmet demand, traded energy, payments, messages and per-household gains/losses without claiming universal improvement. Exact REP, Tata market rules, live meters/weather and role switching remain outside this change because their semantics are unspecified.

## LLM and deployment

Use the lowest-cost current model that passes representative translation tests. Initial candidate is OpenAI `gpt-6-luna` with strict Structured Outputs, no tools, bounded output and no stored Responses. Official price checked 2026-10-30: $0.10 input / $0.50 output per million tokens at Standard rates.

Credentials remain server-only in local Keychain/environment and Streamlit secrets. Never commit secrets. Public requests cannot select a model, endpoint or credential. Cache strategy plans and translations, bound paid calls globally per server and per day, and disclose fallback rather than pretending an LLM ran. Replay and inspection make no paid calls. Exports include normalized plan, model/prompt/schema versions, usage and provenance, without credentials. User prompts may be sent to OpenAI; explain this beside the prompt in concise language.

Keep the public repository and existing Streamlit app. Deliver multiple logical commits, passing automated tests, desktop/mobile visual checks, a verified hosted run, and updated source archive/documentation.
