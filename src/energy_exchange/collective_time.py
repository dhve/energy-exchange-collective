"""Timezone-aware delivery intervals for freely shiftable household energy.

No duration-to-energy or power assumption is made: each household has one
finite energy pool across its declared window.
"""
from datetime import datetime
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Asia/Kolkata')


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError('delivery timestamps must be ISO strings')
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError('delivery timestamps must be ISO timestamps') from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('delivery timestamps must include a timezone offset')
    return parsed.astimezone(ZONE)


def validate_interval(start, end):
    start, end = parse_time(start), parse_time(end)
    if start >= end:
        raise ValueError('delivery interval start must precede end')
    if start.date() != end.date():
        raise ValueError('delivery interval must be within one synthetic day')
    return start.isoformat(), end.isoformat()


def intersection(first, second):
    start = max(parse_time(first[0]), parse_time(second[0]))
    end = min(parse_time(first[1]), parse_time(second[1]))
    return (start.isoformat(), end.isoformat()) if start < end else None


def contains(window, delivery):
    try:
        start, end = (parse_time(v) for v in delivery)
        return parse_time(window[0]) <= start < end <= parse_time(window[1])
    except (ValueError, TypeError):
        return False


def segments(first, second, after=None):
    overlap = intersection(first, second)
    if overlap is None:
        return [None]  # permits a traceable rejection of incompatible windows
    if after is not None and parse_time(overlap[0]) < parse_time(after) < parse_time(overlap[1]):
        boundary = parse_time(after).isoformat()
        return [(overlap[0], boundary), (boundary, overlap[1])]
    return [overlap]
