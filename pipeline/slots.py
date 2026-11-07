#!/usr/bin/env python3
"""
Two briefs a day: an early one and an evening one.

Everything downstream is keyed by a *slug* rather than a bare date, so the
two issues of the same day never collide on disk:

    2026-10-27-am      morning brief
    2026-10-27-pm      evening brief
    2026-10-24         a legacy single-issue day (no slot)

A legacy file keeps working: parse() reports slot "", make() with an empty
slot returns the bare date, and the client treats a missing slot as "just one
issue that day".
"""

import re
from datetime import datetime, timedelta

SLOTS = ("am", "pm")

# When each issue is supposed to go out. A run that fires hours late still
# belongs to the point it was aiming at, not to the clock it woke up at:
# GitHub started the 20:05 job at 03:16 the next morning once, which dated an
# evening brief to the following day and left the real evening empty.
AM_HOUR = 7
PM_HOUR = 20

_SLUG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-(am|pm))?$")


def parse(slug: str):
    """'2026-10-27-pm' -> ('2026-10-27', 'pm'). Raises on nonsense."""
    m = _SLUG_RE.match(slug or "")
    if not m:
        raise ValueError(f"not a brief slug: {slug!r} (want YYYY-MM-DD[-am|-pm])")
    return m.group(1), (m.group(2) or "")


def make(date: str, slot: str = "") -> str:
    return f"{date}-{slot}" if slot else date


def due(now: datetime | None = None):
    """(date, slot) that a run starting now should produce.

    Anchored on the most recent target time, so lateness cannot relabel an
    issue: 07:05-19:59 builds today's morning, 20:00-23:59 today's evening,
    and 00:00-06:59 is still catching up on yesterday's evening.
    """
    now = now or datetime.now()
    if AM_HOUR <= now.hour < PM_HOUR:
        return now.date().isoformat(), "am"
    if now.hour >= PM_HOUR:
        return now.date().isoformat(), "pm"
    return (now - timedelta(days=1)).date().isoformat(), "pm"


def current() -> str:
    """Which issue a run with no explicit --slot should build."""
    return due()[1]


def resolve(slot_arg: str) -> str:
    """Normalise a CLI value: 'auto'/'none'/''/'am'/'pm'."""
    s = (slot_arg or "").strip().lower()
    if s in ("", "auto"):
        return current()
    if s in ("none", "single", "-"):
        return ""
    if s not in SLOTS:
        raise SystemExit(f"--slot must be am, pm, auto or none (got {slot_arg!r})")
    return s


def is_auto(slot_arg: str) -> bool:
    return (slot_arg or "").strip().lower() in ("", "auto")


def next_slot(slot: str) -> str:
    """The other issue of the same day, or '' when there is none."""
    return "pm" if slot == "am" else ("am" if slot == "pm" else "")


# Chinese labels, used by the push card and nowhere else.
LABELS = {"am": "早间", "pm": "晚间"}
ENGLISH = {"am": "Morning edition", "pm": "Evening edition"}


def label(slot: str, english: bool = False) -> str:
    return (ENGLISH if english else LABELS).get(slot, "")
