#!/usr/bin/env python3
"""
Daily Tech Brief — story picker + script writer.

  RSS  ->  pick one story  ->  LLM rewrite into a listening script  ->  content/<date>.json

The rewrite is the whole product. Raw news prose is unlistenable: long clauses,
buried verbs, numbers stacked on numbers. This step turns one story into ~170
words of spoken English: one idea per sentence, 14 words on average.

Usage:
  python3 pipeline/compose.py                       # today
  python3 pipeline/compose.py --date 2026-10-27
  python3 pipeline/compose.py --url <article-url>   # force a story
  python3 pipeline/compose.py --dry-run             # print, do not write

Config (env or .env at repo root):
  LLM_BASE_URL   default https://api.deepseek.com/v1
  LLM_API_KEY    required
  LLM_MODEL      default deepseek-chat
"""

import argparse
import html
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date as date_cls
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"

FEEDS = [
    ("TechCrunch", "https://techcrunch.com/feed/"),
    ("The Verge", "https://www.theverge.com/rss/index.xml"),
    ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    ("MIT Tech Review", "https://www.technologyreview.com/feed/"),
]

# Stories that make bad listening practice: money, personnel, product reviews.
SKIP = ("raises", "funding", "valuation", "acquires", "acquisition", "ipo", "layoff",
        "review:", "hands-on", "best ", "deal", "lawsuit", "stock", "earnings",
        "podcast", "newsletter", "how to ", "tips", "gift guide")

# Topics worth hearing about — raises the score, does not gate.
BOOST = ("ai", "model", "chip", "chipmaker", "data center", "datacenter", "robot",
         "security", "privacy", "browser", "open source", "satellite", "battery",
         "quantum", "semiconductor", "gpu", "training", "inference")

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


# ---------------------------------------------------------------- feed

def fetch(url: str, timeout=25) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout).read()


def strip_tags(raw: str) -> str:
    txt = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = html.unescape(txt)
    return re.sub(r"\s+", " ", txt).strip()


def local(tag: str) -> str:
    """Strip the {namespace} prefix — RSS and Atom disagree on namespaces."""
    return tag.split("}", 1)[-1]


def child_text(el, *names):
    """Find the first descendant whose local tag name matches, namespaces ignored."""
    for ch in el.iter():
        if local(ch.tag) in names and (ch.text or "").strip():
            return ch.text.strip()
    return ""


def item_date(el):
    raw = child_text(el, "pubDate", "published", "updated", "date")
    if not raw:
        return None
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(raw.replace("GMT", "+0000"), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_feed(name, url):
    try:
        root = ET.fromstring(fetch(url))
    except Exception as exc:                       # noqa: BLE001
        print(f"  ! {name}: {exc.__class__.__name__}")
        return []

    items = [e for e in root.iter() if local(e.tag) in ("item", "entry")]

    out = []
    for it in items[:14]:
        title = child_text(it, "title")
        if not title:
            continue
        link = ""
        for ch in it:
            if local(ch.tag) == "link":
                link = (ch.get("href") or (ch.text or "")).strip()
                if link:
                    break
        body = child_text(it, "encoded", "content", "description", "summary")
        out.append({"source": name, "title": html.unescape(title), "url": link,
                    "body": strip_tags(body), "chars": len(strip_tags(body)),
                    "when": item_date(it)})
    return out


def used_urls():
    seen = set()
    for f in CONTENT.glob("*.json"):
        try:
            seen.add(json.loads(f.read_text()).get("source_url", ""))
        except Exception:                          # noqa: BLE001
            pass
    return seen


def score(item) -> float:
    t = item["title"].lower()
    s = 0.0
    s += sum(2 for k in BOOST if k in t)
    s += 1.5 if 40 <= len(item["title"]) <= 95 else 0
    s += 1.0 if item["chars"] > 900 else 0
    s -= 6 * sum(1 for k in SKIP if k in t)
    if item.get("when"):
        age_h = (datetime.now(timezone.utc) - item["when"]).total_seconds() / 3600
        s += 4 if age_h < 12 else (2 if age_h < 30 else -1)
    return s


def pick_story():
    print("Reading feeds...")
    items = []
    for name, url in FEEDS:
        got = parse_feed(name, url)
        print(f"  {name}: {len(got)} items")
        items += got

    seen = used_urls()
    fresh, stale = [], 0
    for i in items:
        if any(k in i["title"].lower() for k in SKIP):
            continue
        if i["url"] in seen:
            stale += 1
            continue
        if i.get("when"):
            age_h = (datetime.now(timezone.utc) - i["when"]).total_seconds() / 3600
            if age_h > 48:
                stale += 1
                continue
        fresh.append(i)

    if stale:
        print(f"  skipped {stale} already-used or older-than-48h stories")
    if not fresh:
        sys.exit("No usable story today. Check the feeds.")

    fresh.sort(key=score, reverse=True)
    best = fresh[0]
    print(f"\nPicked: {best['title']}\n  {best['source']} · {best['chars']} chars of body")
    return best


def article_text(item) -> str:
    """RSS body first (fast, reliable), page scrape as fallback."""
    if item["chars"] >= 700:
        return item["body"][:4000]
    try:
        page = fetch(item["url"]).decode("utf-8", "ignore")
        paras = re.findall(r"<p[^>]*>(.*?)</p>", page, flags=re.S | re.I)
        text = " ".join(strip_tags(p) for p in paras)
        if len(text) > 500:
            return text[:4000]
    except Exception as exc:                       # noqa: BLE001
        print(f"  ! page fetch failed: {exc.__class__.__name__}")
    return item["body"][:4000]


# ---------------------------------------------------------------- LLM

PROMPT = """You write scripts for a daily English listening drill. The reader is a
fluent non-native speaker who wants to understand tech news at natural speed.

Rewrite the article below as spoken American English.

RULES
- 155 to 185 words total. No more.
- 8 to 11 sentences. One idea per sentence. Average 14 words, never over 24.
- Lead with the single most important fact. No throat-clearing, no "in a statement".
- Keep 3 to 5 technical terms, but explain each in plain words the first time.
- Numbers: spell out the ones a listener must catch (forty percent, not 40%).
- No quotes longer than six words. No attributions like "said in a blog post".
- Neutral tone. No hype, no "game-changer", no em dashes chained together.
- Facts must come only from the article. Never invent a number, date or name.

Also produce:
- terms: the 3-5 technical terms, each with a 6-word plain-English gloss.
- focus: one short pronunciation tip per sentence (max 12 words), or "" if boring.
  Target sounds non-native speakers actually miss: th, r/l, final consonants,
  word stress on three-syllable words, linking between words.
- questions: exactly 2 comprehension questions, 3 options each, one correct.
  They must be answerable from the audio alone, not from world knowledge.
- explain: one sentence saying where in the script the answer sits.

Return JSON only, no prose, in exactly this shape:
{
  "headline": "under 60 chars, plain, no clickbait",
  "script": "the spoken script",
  "terms": [{"word": "thermal", "gloss": "about heat"}],
  "focus": ["tip for sentence 1", "tip for sentence 2"],
  "questions": [
    {"q": "...", "options": ["a","b","c"], "answer": 0, "explain": "..."},
    {"q": "...", "options": ["a","b","c"], "answer": 2, "explain": "..."}
  ],
  "recall_prompts": ["What changed?", "Why does it matter?", "Who is affected?"]
}

ARTICLE
-------
Title: {title}
Source: {source}

{body}
"""


def env(key, default=""):
    if os.environ.get(key):
        return os.environ[key]
    envfile = ROOT / ".env"
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            if line.strip().startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


def ask_llm(prompt: str) -> dict:
    base = env("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    key = env("LLM_API_KEY")
    model = env("LLM_MODEL", "deepseek-chat")
    if not key:
        sys.exit("LLM_API_KEY is not set. Put it in .env at the repo root.\n"
                 "  LLM_API_KEY=sk-...\n"
                 "  LLM_BASE_URL=https://api.deepseek.com/v1\n"
                 "  LLM_MODEL=deepseek-chat")

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.5,
        "response_format": {"type": "json_object"},
    }).encode()

    req = urllib.request.Request(
        base + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read())
    text = data["choices"][0]["message"]["content"]
    return json.loads(text)


# ---------------------------------------------------------------- checks

def validate(meta: dict):
    problems = []
    words = len(re.findall(r"[A-Za-z']+", meta["script"]))
    if not 130 <= words <= 210:
        problems.append(f"script is {words} words, wanted 155-185")
    if not 3 <= len(meta.get("terms", [])) <= 6:
        problems.append(f"{len(meta.get('terms', []))} terms, wanted 3-5")
    if len(meta.get("questions", [])) != 2:
        problems.append("needs exactly 2 questions")
    for q in meta.get("questions", []):
        if len(q.get("options", [])) != 3 or not 0 <= q.get("answer", -1) < 3:
            problems.append(f"bad question: {q.get('q', '?')[:40]}")
    return problems, words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date_cls.today().isoformat())
    ap.add_argument("--url", default=None, help="force a specific article")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.url:
        story = {"source": "MANUAL", "title": args.url, "url": args.url, "body": "", "chars": 0}
        body = article_text({**story, "chars": 0})
    else:
        story = pick_story()
        body = article_text(story)

    if len(body) < 400:
        sys.exit("Article body too short to rewrite. Try --url with the full page.")

    prompt = PROMPT.format(title=story["title"], source=story["source"], body=body)
    print("Rewriting with LLM...")
    meta = ask_llm(prompt)

    meta["source"] = story["source"].upper()
    meta["source_url"] = story["url"]
    meta.setdefault("recall_prompts", ["What changed?", "Why does it matter?", "Who is affected?"])

    problems, words = validate(meta)
    if problems:
        print("  ! quality checks:")
        for p in problems:
            print("    -", p)

    if args.dry_run:
        print("\n" + "=" * 60)
        print(meta["headline"], f"({words} words)\n")
        print(meta["script"])
        print("=" * 60)
        return

    CONTENT.mkdir(parents=True, exist_ok=True)
    out = CONTENT / f"{args.date}.json"
    out.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nWrote {out.relative_to(ROOT)} · {words} words · {len(meta['terms'])} terms")


if __name__ == "__main__":
    main()
