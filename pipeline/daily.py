#!/usr/bin/env python3
"""
Daily Tech Brief — one command for the whole morning job.

  compose (pick story + rewrite)  ->  generate (TTS + data)  ->  push (Feishu)

Usage:
  python3 pipeline/daily.py                 # today, full run
  python3 pipeline/daily.py --skip-push
  python3 pipeline/daily.py --date 2026-10-27 --force

Safe to re-run: if data/<date>.json already exists, the day is skipped unless
--force is passed. Nothing is overwritten by accident.
"""

import argparse
import os
import subprocess
import sys
from datetime import date as date_cls
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PY = sys.executable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slots  # noqa: E402

SKIPPED = 3           # exit code: the issue already exists, nothing done


def run(cmd, label):
    print(f"\n=== {label} ===")
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        sys.exit(f"{label} failed ({r.returncode})")


def publish_outputs(slug, built):
    """Hand slug/built to the workflow when running inside Actions."""
    dest = os.environ.get("GITHUB_OUTPUT")
    if not dest:
        return
    with open(dest, "a", encoding="utf-8") as f:
        f.write(f"slug={slug}\nbuilt={'true' if built else 'false'}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None,
                    help="YYYY-MM-DD, or a full slug like 2026-10-27-pm "
                         "(default: whatever issue is due right now)")
    ap.add_argument("--slot", default="auto",
                    help="am / pm / auto (pick by the last target time that passed) "
                         "/ none (single daily issue)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--skip-push", action="store_true")
    ap.add_argument("--skip-compose", action="store_true",
                    help="reuse content/<slug>.json (re-run TTS only)")
    args = ap.parse_args()

    if args.date and args.date.endswith(("-am", "-pm")):
        day, slot = slots.parse(args.date)
    elif args.date:
        # An explicit date plus auto slot is ambiguous, so fall back to the
        # hour of the day rather than to a date-derived guess.
        day, slot = args.date, slots.resolve(args.slot)
    elif slots.is_auto(args.slot):
        day, slot = slots.due()
    else:
        day, slot = date_cls.today().isoformat(), slots.resolve(args.slot)

    # A day can hold two issues, so the guard below is per issue, not per day:
    # re-running the morning job never touches an evening brief.
    slug = slots.make(day, slot)
    shown = slots.label(slot, english=True) or "single issue"
    # flush: the child processes write straight to the same pipe, so without
    # this the header lands after their output and the log reads backwards.
    print(f"Issue: {slug} · {shown}", flush=True)

    if (DATA / f"{slug}.json").exists() and not args.force:
        print(f"{slug} already built. Use --force to rebuild.")
        publish_outputs(slug, False)
        return SKIPPED

    if not args.skip_compose:
        run([PY, "pipeline/compose.py", "--date", day,
             "--slot", slot or "none"], "1/3 pick + rewrite")
    run([PY, "pipeline/generate.py", "--date", slug], "2/3 voices + data")

    if not args.skip_push:
        run([PY, "pipeline/push_feishu.py", "--date", slug], "3/3 push to Feishu")

    print(f"\nDone. {slug} is live.")
    publish_outputs(slug, True)


if __name__ == "__main__":
    sys.exit(main())
