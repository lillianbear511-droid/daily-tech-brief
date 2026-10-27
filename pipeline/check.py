#!/usr/bin/env python3
"""
Daily Tech Brief — preflight check.

  python3 pipeline/check.py              # everything
  python3 pipeline/check.py --skip-push  # do not send a Feishu message

Answers one question: will the next 07:05 or 20:05 run actually work?
Checks the five things that break in practice — the API key, the balance,
the Feishu bot, the RSS sources, and the GitHub secrets.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OK, BAD, WARN = "\033[32m  ok \033[0m", "\033[31m fail\033[0m", "\033[33m warn\033[0m"

FEEDS = [
    ("TechCrunch", "https://techcrunch.com/feed/"),
    ("The Verge", "https://www.theverge.com/rss/index.xml"),
    ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    ("MIT Tech Review", "https://www.technologyreview.com/feed/"),
]


def env(key, default=""):
    if os.environ.get(key):
        return os.environ[key]
    envfile = ROOT / ".env"
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            line = line.strip()
            if line.startswith(key + "=") and not line.startswith("#"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


def line(tag, name, detail=""):
    print(f"[{tag}] {name}" + (f"  —  {detail}" if detail else ""))


def mask(s):
    return s[:6] + "..." + s[-4:] if len(s) > 12 else "(set)"


# ---------------------------------------------------------------- guard

def check_guard():
    """Before anything else: can the key I just typed end up in a git push?"""
    print("\n\033[1m0. secret guard\033[0m")
    ok = True

    gi = ROOT / ".gitignore"
    rules = {l.strip() for l in gi.read_text().splitlines()} if gi.exists() else set()
    if ".env" in rules and ".env.*" in rules and "!.env.example" in rules:
        line(OK, ".gitignore", "blocks .env and .env.*, keeps .env.example")
    elif ".env" in rules:
        line(WARN, ".gitignore", "blocks .env only — .env.local / .env.bak would still leak")
        ok = False
    else:
        line(BAD, ".gitignore", ".env is NOT ignored")
        ok = False

    dep = ROOT / "pipeline" / "deploy.sh"
    if dep.exists():
        txt = dep.read_text()
        if ".env*" in txt:
            line(OK, "deploy.sh", "drops .env* from the publish copy")
        else:
            line(BAD, "deploy.sh", "would push .env — your key would go public")
            ok = False

    envfile = ROOT / ".env"
    if envfile.exists():
        mode = envfile.stat().st_mode & 0o777
        if mode & 0o077:
            line(WARN, ".env permissions", f"{oct(mode)} — tighten with: chmod 600 .env")
        else:
            line(OK, ".env permissions", oct(mode))
    return ok


# ---------------------------------------------------------------- config

def check_env():
    print("\n\033[1m1. local config\033[0m")
    good = True
    envfile = ROOT / ".env"
    if not envfile.exists():
        line(BAD, ".env", "missing — copy .env.example to .env")
        return False
    line(OK, ".env", str(envfile))

    key = env("LLM_API_KEY")
    if key.startswith("sk-") and len(key) > 20:
        line(OK, "LLM_API_KEY", mask(key))
    elif key:
        line(WARN, "LLM_API_KEY", f"set but looks odd ({mask(key)}) — DeepSeek keys start with sk-")
        good = False
    else:
        line(BAD, "LLM_API_KEY", "empty — get one at platform.deepseek.com/api_keys")
        good = False

    hook = env("FEISHU_WEBHOOK")
    if "open.feishu.cn/open-apis/bot/v2/hook/" in hook:
        line(OK, "FEISHU_WEBHOOK", mask(hook))
    else:
        line(BAD, "FEISHU_WEBHOOK", "empty or malformed — should contain /open-apis/bot/v2/hook/")
        good = False

    app = env("APP_URL")
    if app.startswith("https://"):
        line(OK, "APP_URL", app)
    else:
        line(WARN, "APP_URL", "not set — push cards will have no deep link")

    line(OK if env("LLM_BASE_URL") else WARN,
         "LLM_BASE_URL", env("LLM_BASE_URL", "https://api.deepseek.com/v1 (default)"))
    line(OK if env("LLM_MODEL") else WARN,
         "LLM_MODEL", env("LLM_MODEL", "deepseek-chat (default)"))
    return good


# ---------------------------------------------------------------- deepseek

def check_api():
    print("\n\033[1m2. DeepSeek API\033[0m")
    base = env("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    key = env("LLM_API_KEY")
    if not key:
        line(BAD, "skipped", "no key")
        return False

    # Reachability + key validity in one shot. /models is free.
    req = urllib.request.Request(base + "/models",
                                 headers={"Authorization": f"Bearer {key}"})
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read())
        ms = int((time.time() - t0) * 1000)
        models = [m.get("id") for m in data.get("data", [])]
        line(OK, "auth", f"{ms} ms, {len(models)} models: {', '.join(models[:4])}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:200]
        if e.code == 401:
            line(BAD, "auth", f"401 — key rejected. {body}")
        elif e.code == 402:
            line(BAD, "auth", f"402 — key valid but balance is zero. Top up at platform.deepseek.com/topup")
        elif e.code == 404:
            line(BAD, "auth", f"404 — wrong base URL. Use https://api.deepseek.com/v1")
        else:
            line(BAD, "auth", f"HTTP {e.code} — {body}")
        return False
    except Exception as e:
        line(BAD, "reachability", f"{type(e).__name__}: {e} — check your network / proxy")
        return False

    # One real call: proves the model name, the balance, and the latency.
    model = env("LLM_MODEL", "deepseek-chat")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
        "max_tokens": 4,
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        base + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
        ms = int((time.time() - t0) * 1000)
        reply = data["choices"][0]["message"]["content"].strip()
        line(OK, model, f"replied {reply!r} in {ms} ms")
    except urllib.error.HTTPError as e:
        line(BAD, model, f"HTTP {e.code} — {e.read().decode(errors='replace')[:200]}")
        return False
    except Exception as e:
        line(BAD, model, f"{type(e).__name__}: {e}")
        return False
    return True


# ---------------------------------------------------------------- feishu

def check_feishu(send):
    print("\n\033[1m3. Feishu bot\033[0m")
    hook = env("FEISHU_WEBHOOK")
    if not hook:
        line(BAD, "skipped", "no webhook")
        return False
    if not send:
        line(WARN, "skipped", "not sending (--skip-push)")
        return True

    payload = {
        "msg_type": "text",
        "content": {"text": "Daily Tech Brief · 连接测试\n看到这条说明机器人通了，每天 07:05 和 20:05 各推一条。"},
    }
    req = urllib.request.Request(
        hook, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            res = json.loads(r.read())
    except Exception as e:
        line(BAD, "send", f"{type(e).__name__}: {e}")
        return False

    code = res.get("code", res.get("StatusCode", -1))
    if code == 0:
        line(OK, "send", "test card delivered — check your Feishu group")
        return True
    hints = {
        19021: "signature check failed — the bot has secret enabled, turn it off or add the signature",
        11232: "frequency limit — wait a minute",
    }
    line(BAD, "send", f"code {code}: {res.get('msg', '')}  {hints.get(code, '')}".strip())
    return False


# ---------------------------------------------------------------- feeds

def check_feeds():
    print("\n\033[1m4. RSS sources\033[0m")
    alive = 0
    for name, url in FEEDS:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read()
            n = raw.count(b"<item") + raw.count(b"<entry")
            if n:
                line(OK, name, f"{n} stories, {len(raw)//1024} KB")
                alive += 1
            else:
                line(WARN, name, "reachable but no items found")
        except Exception as e:
            line(WARN, name, f"{type(e).__name__}: {str(e)[:60]}")
    line(OK if alive >= 2 else BAD, "usable sources", f"{alive} of {len(FEEDS)} (need 2+)")
    return alive >= 2


# ---------------------------------------------------------------- github

def check_secrets():
    print("\n\033[1m5. GitHub Actions\033[0m")
    import shutil
    import subprocess
    if not shutil.which("gh"):
        line(WARN, "skipped", "gh CLI not installed")
        return True
    try:
        out = subprocess.run(
            ["gh", "secret", "list", "-R", "lillianbear511-droid/daily-tech-brief"],
            capture_output=True, text=True, timeout=30)
    except Exception as e:
        line(WARN, "skipped", str(e)[:60])
        return True
    if out.returncode != 0:
        line(WARN, "gh", (out.stderr or "").strip()[:100])
        return True

    have = {l.split()[0] for l in out.stdout.splitlines() if l.strip()}
    for name in ("LLM_API_KEY", "FEISHU_WEBHOOK", "APP_URL"):
        if name in have:
            line(OK, "secret " + name, "set")
        else:
            line(BAD, "secret " + name, "missing — the scheduled runs will fail")
    return {"LLM_API_KEY", "FEISHU_WEBHOOK"} <= have


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-push", action="store_true", help="do not send a Feishu test message")
    a = ap.parse_args()

    print("\n\033[1mDaily Tech Brief — preflight\033[0m")
    results = [
        check_guard(),
        check_env(),
        check_api(),
        check_feishu(not a.skip_push),
        check_feeds(),
        check_secrets(),
    ]

    ok = all(results)
    print()
    if ok:
        print("\033[32mAll clear.\033[0m The scheduled runs will work. "
              "Try it now: python3 pipeline/daily.py --slot pm\n")
    else:
        print("\033[31mSomething is off.\033[0m Fix the red lines above, then run this again.\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
