#!/usr/bin/env python3
"""
Daily Tech Brief — Feishu (Lark) group bot push.

Sends one card at the top of the morning: headline, length, one button.
The button deep-links to that specific day, so opening an old card still works.

Usage:
  python3 pipeline/push_feishu.py                    # today's brief
  python3 pipeline/push_feishu.py --date 2026-10-27
  python3 pipeline/push_feishu.py --text-only        # fallback if card fails

Config (.env at repo root):
  FEISHU_WEBHOOK   https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
  APP_URL          https://your-name.github.io/daily-tech-brief
"""

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def env(key, default=""):
    if os.environ.get(key):
        return os.environ[key]
    envfile = ROOT / ".env"
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            if line.strip().startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


def post(payload: dict) -> dict:
    hook = env("FEISHU_WEBHOOK")
    if not hook:
        sys.exit("FEISHU_WEBHOOK is not set. Add it to .env:\n"
                 "  FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx")
    req = urllib.request.Request(
        hook, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def build_card(day: dict, app_url: str) -> dict:
    link = f"{app_url}/?d={day['date']}#/today"
    mins = max(1, round(day.get("duration", 60) / 60))
    terms = " · ".join(t["word"] for t in day.get("terms", [])[:3])

    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True, "enable_forward": True},
            "header": {
                "template": "orange",
                "title": {"tag": "plain_text", "content": "Today's brief · 90 sec"},
            },
            "elements": [
                {"tag": "div",
                 "text": {"tag": "lark_md",
                          "content": f"**{day['headline']}**"}},
                {"tag": "div",
                 "text": {"tag": "lark_md",
                          "content": f"<font color='grey'>{day['source']} · "
                                     f"{len(day['sentences'])} sentences · ~{mins} min</font>"}},
                {"tag": "div",
                 "text": {"tag": "lark_md",
                          "content": f"<font color='grey'>Key terms: {terms}</font>"}},
                {"tag": "hr"},
                {"tag": "action",
                 "actions": [{
                     "tag": "button",
                     "text": {"tag": "plain_text", "content": "Start practice"},
                     "type": "primary",
                     "url": link,
                 }]},
            ],
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None)
    ap.add_argument("--text-only", action="store_true")
    args = ap.parse_args()

    index = json.loads((DATA / "index.json").read_text())
    days = index.get("days", [])
    if not days:
        sys.exit("No days in data/index.json yet. Run generate.py first.")

    date = args.date or days[0]["date"]
    path = DATA / f"{date}.json"
    if not path.exists():
        sys.exit(f"missing {path}")
    day = json.loads(path.read_text())

    app_url = env("APP_URL").rstrip("/")
    if not app_url:
        sys.exit("APP_URL is not set. Add it to .env:\n"
                 "  APP_URL=https://your-name.github.io/daily-tech-brief")

    payload = ({"msg_type": "text",
                "content": {"text": f"Today's brief — {day['headline']}\n"
                                    f"{app_url}/?d={date}#/today"}}
               if args.text_only else build_card(day, app_url))

    res = post(payload)
    code = res.get("code", res.get("StatusCode", -1))
    if code not in (0, None):
        sys.exit(f"Feishu rejected the card: {res}")
    print(f"Pushed {date} to Feishu · {day['headline']}")


if __name__ == "__main__":
    main()
