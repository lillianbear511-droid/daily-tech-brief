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
import subprocess
import sys
from datetime import date as date_cls
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PY = sys.executable


def run(cmd, label):
    print(f"\n=== {label} ===")
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        sys.exit(f"{label} failed ({r.returncode})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date_cls.today().isoformat())
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--skip-push", action="store_true")
    ap.add_argument("--skip-compose", action="store_true",
                    help="reuse content/<date>.json (re-run TTS only)")
    args = ap.parse_args()

    day = args.date
    if (DATA / f"{day}.json").exists() and not args.force:
        print(f"{day} already built. Use --force to rebuild.")
        return

    if not args.skip_compose:
        run([PY, "pipeline/compose.py", "--date", day], "1/3 pick + rewrite")
    run([PY, "pipeline/generate.py", "--date", day], "2/3 voices + data")

    if not args.skip_push:
        run([PY, "pipeline/push_feishu.py", "--date", day], "3/3 push to Feishu")

    print(f"\nDone. {day} is live.")


if __name__ == "__main__":
    main()
