"""Validated, bounded price trajectories; execution never calls a model."""
import copy

PLAN_VERSION = 'bounded-price-plan-v1'


def default_strategy_plan(agents):
    return {'version': PLAN_VERSION, 'source': 'rules', 'agents': {
        a['id']: {'price_positions': [9000, 7000, 5000] if a['role'] == 'seller'
                  else [1000, 3000, 6000]} for a in agents}}


def validate_strategy_plan(plan, agents):
    if not isinstance(plan, dict) or plan.get('version') != PLAN_VERSION:
        raise ValueError(f'strategy plan version must be {PLAN_VERSION}')
    if not isinstance(plan.get('source'), str) or not 1 <= len(plan['source']) <= 100:
        raise ValueError('strategy plan source must be a short string')
    profiles = {a['id']: a for a in agents}
    if not isinstance(plan.get('agents'), dict) or set(plan['agents']) != set(profiles):
        raise ValueError('strategy plan must cover exactly the world households')
    for aid, strategy in plan['agents'].items():
        if not isinstance(strategy, dict) or set(strategy) != {'price_positions'}:
            raise ValueError(f'{aid}: strategy needs only price_positions')
        values = strategy['price_positions']
        if not isinstance(values, list) or len(values) != 3 or any(
                type(v) is not int or not 0 <= v <= 10000 for v in values):
            raise ValueError(f'{aid}: three integer basis-point positions are required')
        ordered = sorted(values, reverse=profiles[aid]['role'] == 'seller')
        if values != ordered:
            raise ValueError(f'{aid}: price positions must concede monotonically')
    # Optional provider provenance is carried but never interpreted as instructions.
    return copy.deepcopy(plan)


def quote_price(floor, maximum, tick, position):
    """Position in the declared band, rounded half up to a valid price tick."""
    if floor > maximum:
        return None
    raw = floor * 10000 + (maximum - floor) * position
    price = tick * ((raw + tick * 5000) // (tick * 10000))
    return max(floor, min(maximum, price))
