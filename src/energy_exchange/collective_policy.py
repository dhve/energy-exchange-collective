"""Strict, deterministic instruction proposals. Parsing never executes a trade."""
from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
import math
import re

PARSER_VERSION = 'energy-policy-grammar/2.1'
NUM = r'(\d+(?:\.\d+)?)'
MONEY = r'(?:₹|inr\s*|rs\.?\s*)?'
UNIT = r'(?:\s*/\s*kwh|\s+per\s+kwh)?'
LIMITS = {'min_price': 100, 'max_price': 100, 'budget': 10000,
          'max_offer_kwh': 1000, 'forecast_surplus_kwh': 1000,
          'reserve_kwh': 1000, 'demand_kwh': 1000, 'deadline_round': 50}


def parse_instruction(text: str, agent: dict, price_tick: float = 0.05) -> dict:
    result = dict(changes={}, recognized=[], errors=[], requires_confirmation=True,
                  parser_version=PARSER_VERSION)
    errors, recognized = result['errors'], result['recognized']
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        errors.append('Enter an instruction of 1 to 2000 characters.')
        return result
    role = agent.get('role')
    if role not in ('buyer', 'seller'):
        errors.append('Select a household agent first.')
        return result
    normalized = text.lower().replace('–', '-').replace('—', '-').replace('’', "'")
    if re.search(r'(?:^|\s|₹)-\s*\d', normalized):
        errors.append('Amounts must be nonnegative.')
        return result
    changes = {}
    remaining = normalized

    def add(key, value, label, required_role=None):
        if required_role and required_role != role:
            errors.append(f'{label} is only available for a {required_role}.')
        if key in changes and changes[key] != value:
            errors.append(f'Conflicting values for {label.lower()}.')
        changes[key] = value
        recognized.append(label)

    def consume(pattern, callback):
        nonlocal remaining
        def substitute(match):
            callback(match)
            return ' '
        remaining = re.sub(pattern, substitute, remaining)

    consume(r'accept\s+' + MONEY + NUM + UNIT + r'\s+only\s+if\s+(?:at\s+least\s+)?' + NUM
            + r'\s*kwh\s+(?:is\s+)?sold\s+together',
            lambda m: add('conditional_price', {'floor': float(m[1]), 'minimum_kwh': float(m[2])},
                          'Conditional bundle price', 'seller'))
    consume(r'(?:remove|clear)\s+(?:my\s+)?bundle\s+discount',
            lambda m: add('conditional_price', None, 'Remove conditional bundle price', 'seller'))
    consume(r'(?:sell|offer)\s+(?:up\s+to\s+)?' + NUM + r'\s*kwh',
            lambda m: add('max_offer_kwh', float(m[1]), 'Maximum offer', 'seller'))
    consume(r'(?:buy|purchase|need)\s+(?:up\s+to\s+)?' + NUM + r'\s*kwh',
            lambda m: add('demand_kwh', float(m[1]), 'Energy requirement', 'buyer'))
    consume(r'(?:keep|reserve)\s+(?:at\s+least\s+)?' + NUM + r'\s*kwh(?:\s+in\s+reserve)?',
            lambda m: add('reserve_kwh', float(m[1]), 'Minimum reserve', 'seller'))
    consume(r'(?:at\s+)?at\s+least\s+' + MONEY + NUM + UNIT,
            lambda m: add('min_price', float(m[1]), 'Minimum price', 'seller'))
    consume(r'(?:at\s+)?at\s+most\s+' + MONEY + NUM + UNIT,
            lambda m: add('max_price', float(m[1]), 'Maximum price', 'buyer'))
    consume(r'(?:(?:make|set|raise|lower|change|reduce|increase)\s+)?(?:(?:my|the)\s+)?(?:(?:minimum|min|selling)\s+price|price\s+floor)\s+(?:to\s+)?'
            + MONEY + NUM + UNIT,
            lambda m: add('min_price', float(m[1]), 'Minimum price', 'seller'))
    consume(r'(?:(?:make|set|raise|lower|change|reduce|increase)\s+)?(?:(?:my|the)\s+)?(?:(?:maximum|max|buying)\s+price|price\s+ceiling)\s+(?:to\s+)?'
            + MONEY + NUM + UNIT,
            lambda m: add('max_price', float(m[1]), 'Maximum price', 'buyer'))
    consume(r'(?:(?:set|raise|lower|change|reduce|increase)\s+)?(?:my\s+|a\s+)?budget\s+(?:to\s+|of\s+)?' + MONEY + NUM,
            lambda m: add('budget', float(m[1]), 'Budget', 'buyer'))
    consume(r'(?:(?:set|change|reduce|increase)\s+)?(?:my\s+)?(?:available\s+)?(?:solar\s+)?surplus\s+(?:to\s+)?' + NUM + r'\s*kwh',
            lambda m: add('forecast_surplus_kwh', float(m[1]), 'Forecast surplus', 'seller'))
    consume(r'(?:(?:set|change)\s+)?(?:my\s+)?deadline\s+(?:to\s+)?round\s+' + NUM,
            lambda m: add('deadline_round', float(m[1]), 'Deadline round'))

    def wall_time(value, minute, meridiem):
        number = int(value)
        minutes = int(minute or 0)
        if not 1 <= number <= 12 or not 0 <= minutes < 60:
            raise ValueError('Use a valid time with AM or PM.')
        hour = number % 12 + (12 if meridiem == 'pm' else 0)
        return datetime.fromisoformat(agent['interval_start']).replace(hour=hour, minute=minutes, second=0, microsecond=0)

    def time_window(m):
        try:
            start = wall_time(m[1], m[2], m[3] or m[6])
            end = wall_time(m[4], m[5], m[6])
            if end <= start:
                if m[3] == 'pm' and m[6] == 'am':
                    end += timedelta(days=1)
                else:
                    raise ValueError('Give both times with AM or PM and put the ending time after the start.')
            add('interval_start', start.isoformat(), 'Delivery starts, Asia/Kolkata')
            add('interval_end', end.isoformat(), 'Delivery ends, Asia/Kolkata')
        except (ValueError, KeyError) as exc:
            errors.append(str(exc) or 'The delivery window could not be validated.')

    def late_price(m):
        try:
            when = wall_time(m[2], m[3], m[4])
            add('time_price', {'after': when.isoformat(), 'floor': float(m[1])},
                'Lower selling price for later delivery', 'seller')
        except (ValueError, KeyError):
            errors.append('Give a valid delivery time for the lower price.')

    consume(r'from\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)', time_window)
    consume(r'accept\s+' + MONEY + NUM + UNIT + r'\s+after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)', late_price)
    consume(r'(?:remove|clear)\s+(?:my\s+)?(?:later|time)\s+discount',
            lambda m: add('time_price', None, 'Remove later delivery discount', 'seller'))
    remaining = re.sub(r'\b(?:and|with|please)\b', ' ', remaining)
    remaining = re.sub(r'[\s,;.!]+', '', remaining)
    if remaining:
        errors.append('Part of this instruction is unsupported. Use one of the examples or the structured controls; no partial change was applied.')
    if not changes:
        errors.append('No supported policy changes were recognized.')
    for key, value in changes.items():
        maximum = LIMITS.get(key, 10000)
        if isinstance(value, (int, float)) and (not math.isfinite(value) or not 0 <= value <= maximum):
            errors.append(f'{key} must be between 0 and {maximum}.')
        elif isinstance(value, (int, float)) and key != 'deadline_round':
            unit = price_tick if key in ('min_price', 'max_price') else 0.01 if key == 'budget' else 0.001
            if Decimal(str(value)) % Decimal(str(unit)):
                errors.append(f'{key} must use increments of {unit}.')
    if 'deadline_round' in changes:
        deadline = changes['deadline_round']
        if not math.isfinite(deadline) or not 1 <= deadline <= 50 or deadline != int(deadline):
            errors.append('Deadline must be a whole round from 1 to 50.')
        else:
            changes['deadline_round'] = int(deadline)
    conditional = changes.get('conditional_price', agent.get('conditional_price'))
    if conditional:
        floor = changes.get('min_price', agent.get('min_price', 0))
        if not (0 <= conditional['floor'] <= 100 and 0 < conditional['minimum_kwh'] <= 1000):
            errors.append('Bundle price must be from 0 to 100 and bundle quantity must be above 0 and at most 1000 kWh.')
        elif Decimal(str(conditional['floor'])) % Decimal(str(price_tick)) or Decimal(str(conditional['minimum_kwh'])) % Decimal('0.001'):
            errors.append('The bundle price must follow the price tick and its quantity must use whole watt hours.')
        if conditional['floor'] >= floor or conditional['minimum_kwh'] <= 0:
            errors.append('A bundle needs a positive quantity and a discount below the ordinary floor.')
        if conditional['minimum_kwh'] > changes.get('max_offer_kwh', agent.get('max_offer_kwh', 0)):
            errors.append('The bundle threshold exceeds the maximum offered quantity.')
    errors.extend(validate_policy_changes(changes, agent, price_tick))
    if not errors:
        result['changes'] = changes
    result['recognized'] = list(dict.fromkeys(recognized))
    return result


def validate_policy_changes(changes: dict, agent: dict, price_tick: float = 0.05) -> list[str]:
    """Independent bounds check shared by grammar and model translation."""
    from .collective_engine import _validate_changes
    if not changes:
        return ['No complete policy change was provided.']
    for key, value in changes.items():
        if key in LIMITS:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                return [f'{key} must be a finite number.']
            if not 0 <= value <= LIMITS[key]:
                return [f'{key} must be between 0 and {LIMITS[key]}.']
        if key in ('conditional_price', 'time_price') and value is not None:
            if not isinstance(value, dict) or not isinstance(value.get('floor'), (int, float)) or isinstance(value.get('floor'), bool) or not math.isfinite(value['floor']) or not 0 <= value['floor'] <= 100:
                return ['A conditional price must be a finite amount from 0 to 100.']
            if key == 'conditional_price' and (not isinstance(value.get('minimum_kwh'), (int, float)) or isinstance(value.get('minimum_kwh'), bool) or not 0 < value['minimum_kwh'] <= 1000):
                return ['The bundle quantity must be above 0 and at most 1000 kWh.']
    try:
        _validate_changes(agent, changes, round(price_tick * 100))
    except (ValueError, KeyError, TypeError, OverflowError) as exc:
        return [str(exc)[:250]]
    return []
