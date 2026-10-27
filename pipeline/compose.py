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
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
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
        "podcast", "newsletter", "how to ", "tips", "gift guide",
        # multi-story digests: one link that jumps between three topics is
        # impossible to shadow out loud
        "the download:", "digest", "roundup",
        # book reviews and opinion columns read as culture, not news
        "book", "author", "memoir", "essay", "biography", "opinion", "column",
        "obituary", "takes aim at", "we need to talk")

# Shopping listicles ("the hottest AI gadgets you should know about") read like
# news but are product recommendations, not events. No score can rescue them.
LISTICLE = ("hottest", "you should know", "gadgets", "buying guide", "we tested",
            "our favorite", "our pick", "top picks", "worth buying", "worth the",
            "roundup", "shopping", "price drop", "we recommend", "most popular",
            "wishlist", "gifts for", "deal of the day")

# Topics worth hearing about — raises the score, does not gate.
BOOST = ("ai", "model", "chip", "chipmaker", "data center", "datacenter", "robot",
         "security", "privacy", "browser", "open source", "satellite", "battery",
         "quantum", "semiconductor", "gpu", "training", "inference")

# Entertainment press, not tech news. A story about a film that happens to
# involve AI is still a film story — it teaches the ear nothing useful.
OFFTOPIC = ("box office", "box-office", "hollywood", "the film", "the movie",
            "movie studio", "film studio", "moviegoers", "film critics",
            "trailer", "casting call", "red carpet", "celebrity", "the sequel",
            "netflix series", "tv series", "oscar", "emmy award", "grammy")

# Politics and geopolitics: hard exclude, no score can rescue them.
# Partisan or war coverage is unusable as a neutral listening drill, and the
# reader is a Chinese user for whom this material is simply not appropriate.
POLITICS = ("republican", "democrat", "trump", "biden", "harris", "election",
            "senate", "congress", "white house", "supreme court", "gop",
            "ukraine", "russia", "israel", "gaza", "hamas", "military strike",
            "sanctions", "nato", "immigration", "abortion", "partisan",
            # Stories that frame a normal technical finding as cross-border
            # espionage. They read as geopolitics, not as technology, and the
            # tone is wrong for a listening drill.
            "espionage", "spy", "spying", "spied", "exfiltrat", "beijing",
            "kremlin", "pentagon", "state-sponsored", "export control")

# Buyer's-guide phrasing. Several of these in one body means the piece is a
# recommendation list wearing a news headline.
SHOPPING = ("you should know", "we tested", "our favorite", "you can buy",
            "best overall", "worth the price", "buy now", "starting at $",
            "available for $", "we recommend", "our pick", "the best")

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}


# ---------------------------------------------------------------- feed

# Two openers: the default honours http_proxy, the direct one ignores it.
# Flaky local proxies are the single most common reason a feed "disappears",
# and GitHub Actions has no proxy at all — so retry once, bypassing the proxy.
_VIA_PROXY = urllib.request.build_opener()
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch(url: str, timeout=25) -> bytes:
    """GET with one retry. The retry goes direct — if the proxy just failed,
    asking it again is pointless; if the proxy is merely slow, direct wins."""
    last = None
    for attempt, opener in enumerate((_VIA_PROXY, _DIRECT)):
        wait = timeout if attempt == 0 else max(6, timeout // 2)
        try:
            req = urllib.request.Request(url, headers=UA)
            return opener.open(req, timeout=wait).read()
        except Exception as e:
            last = e
            if attempt == 0:
                time.sleep(0.5)
    raise last


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
        root = ET.fromstring(fetch(url, timeout=15))
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
    s -= 5 * sum(1 for k in OFFTOPIC if k in t)
    if item.get("when"):
        age_h = (datetime.now(timezone.utc) - item["when"]).total_seconds() / 3600
        s += 4 if age_h < 12 else (2 if age_h < 30 else -1)
    return s


def is_off_topic(text: str) -> bool:
    """Called on the full article body, where the tell-tale words actually live."""
    low = text.lower()
    entertainment = sum(1 for k in OFFTOPIC if k in low)
    politics = sum(1 for k in POLITICS if k in low)
    # A title can look like news while the body is a buyer's guide, so check
    # the prose too. Threshold is high because honest business reporting also
    # mentions prices.
    shopping = sum(1 for k in SHOPPING if k in low)
    return entertainment >= 2 or politics >= 3 or shopping >= 4


def pick_story():
    print("Reading feeds...")
    items = []
    # Parallel: a dead feed costs one timeout, not four. Order is preserved so
    # the printout still reads top-to-bottom like the FEEDS list.
    with ThreadPoolExecutor(max_workers=len(FEEDS)) as pool:
        got_all = list(pool.map(lambda nf: parse_feed(*nf), FEEDS))
    for (name, _), got in zip(FEEDS, got_all):
        print(f"  {name}: {len(got)} items")
        items += got

    seen = used_urls()
    fresh, stale, dropped = [], 0, {"skip": 0, "politics": 0, "listicle": 0}
    for i in items:
        low = i["title"].lower()
        if any(k in low for k in SKIP):
            dropped["skip"] += 1
            continue
        if any(k in low for k in POLITICS):
            dropped["politics"] += 1
            continue
        if any(k in low for k in LISTICLE):
            dropped["listicle"] += 1
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

    print(f"  dropped {dropped['skip']} off-format, {dropped['politics']} political, "
          f"{dropped['listicle']} shopping listicles")
    if stale:
        print(f"  skipped {stale} already-used or older-than-48h stories")
    if not fresh:
        sys.exit("No usable story today. Check the feeds.")

    fresh.sort(key=score, reverse=True)
    # Prefer headlines that name a real tech subject. Book reviews and culture
    # pieces can still score well on length and recency, so rank them last
    # rather than trusting the score alone. Fall back if the day is thin.
    focused = [i for i in fresh if any(k in i["title"].lower() for k in BOOST)]
    pool = focused if len(focused) >= 3 else fresh
    return pool[:6]


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


def page_title(url: str) -> str:
    """Real headline for a manual --url run.

    Without this the URL itself is handed to the model as the title, which
    quietly poisons the rewrite.
    """
    try:
        page = fetch(url).decode("utf-8", "ignore")
        m = re.search(r"<title[^>]*>(.*?)</title>", page, flags=re.S | re.I)
        raw = strip_tags(m.group(1)) if m else ""
        # Drop the site suffix most outlets append: "Foo | The Verge".
        raw = re.split(r"\s+[|\u2013\u2014-]\s+", raw)[0].strip()
        return raw[:120]
    except Exception:                              # noqa: BLE001
        return ""


# ---------------------------------------------------------------- LLM

PROMPT = """You write scripts for a daily English listening drill. The reader is a
fluent Chinese speaker who wants to follow tech news at natural speed and needs
a Chinese version to check himself against.

Rewrite the article below as spoken American English.

RULES
- 155 to 185 words total. Count them before you answer. Under 150 is a fail.
- 11 to 13 sentences. One idea per sentence. Average 14 words, never over 24.
  (11 x 14 = 154 and 13 x 16 = 208, so this lands inside the word budget.)
- Lead with the single most important fact. No throat-clearing, no "in a statement".
- Keep 3 to 5 technical terms, but explain each in plain words the first time.
- Numbers: spell out the ones a listener must catch (forty percent, not 40%).
- No quotes longer than six words. No attributions like "said in a blog post".
- Neutral tone. No hype, no "game-changer", no em dashes chained together.
- Facts must come only from the article. Never invent a number, date or name.

Every sentence is one entry in "lines", and carries three fields:
- en: the English sentence.
- zh: a natural Simplified Chinese translation. Translate the meaning, not the
  words, and write it the way a Chinese news reader would say it. Keep company
  names, products and market terms in their normal Chinese form (S&P 500 ->
  标普500). Do not invent content that is not in the English. Exactly one
  sentence in, one sentence out — never merge two lines or split one.
  Use one rendering per term for the whole script. In particular: agent is
  智能体 (never 代理, which reads as "proxy server"), always-on / persistent is
  常驻, prompting is 提示词. A reader comparing the English and the Chinese
  should see the same word translated the same way every time.
- focus: one short pronunciation tip (max 12 words), or "" if the sentence is
  plain. Only point at a feature the spelling reveals: the th sound, a final
  consonant that Chinese speakers drop, v versus w, l versus r, the -ed or -s
  ending, or two words that link. Never say which syllable is stressed — you
  cannot check that, and a wrong stress tip teaches the wrong rhythm. Never
  claim a "th" in a word that has no "th". A wrong tip is worse than no tip,
  because the reader will practise the wrong thing.

Also produce:
- terms: the 3-5 technical terms, each with word, zh (the Chinese term a
  Chinese reader would recognise) and note (one short Chinese sentence saying
  what it means here).
- grammar: 2 or 3 points. Each has line (the 1-based sentence number it comes
  from), point (name the structure, e.g. "现在完成时 have delivered") and note (one
  Chinese sentence: why this structure is used here and what a Chinese speaker
  tends to get wrong with it). Pick structures a Chinese learner genuinely
  stumbles on: tense choice, articles, prepositions, relative clauses,
  participle phrases, inversion, countable versus uncountable nouns. Skip
  anything a fluent reader already knows — three real points beat five trivial ones.
- questions: exactly 2 comprehension questions, 3 options each, one correct.
  They must be answerable from the audio alone, not from world knowledge.
- explain: one sentence saying where in the script the answer sits.

Return JSON only, no prose, in exactly this shape:
{{
  "headline": "under 60 chars, plain, no clickbait",
  "lines": [
    {{"en": "the English sentence", "zh": "中文译文", "focus": "tip or empty string"}}
  ],
  "terms": [{{"word": "thermal", "zh": "散热的", "note": "指靠流动空气带走热量，而不是用风扇。"}}],
  "grammar": [{{"line": 4, "point": "现在完成时 have delivered", "note": "强调到目前为止的结果，中文习惯说“已经”而容易漏掉 have。"}}],
  "questions": [
    {{"q": "...", "options": ["a","b","c"], "answer": 0, "explain": "..."}},
    {{"q": "...", "options": ["a","b","c"], "answer": 2, "explain": "..."}}
  ],
  "recall_prompts": ["What changed?", "Why does it matter?", "Who is affected?"]
}}

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
        for raw in envfile.read_text().splitlines():
            line = raw.strip()
            # A commented-out line must stay dead: "#LLM_API_KEY=old" is not a key.
            if not line.startswith(key + "="):
                continue
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            return re.split(r"\s+#", val)[0].strip()   # drop a trailing "  # note"
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

def clean_focus(focus, script):
    """The model invents sounds that are not in the word — it will happily say
    "the th in 'accountability'" or "the th in 'tough'". Both are wrong, and a
    wrong tip trains the reader to do the wrong thing. Check every tip against
    the script and blank out the liars. The array keeps its length because
    generate.py pairs tip[i] with sentence[i] positionally."""
    low = script.lower()
    out = []
    for tip in focus or []:
        tip = (tip or "").strip()
        if not tip:
            out.append("")
            continue
        quoted = re.findall(r"['\u2018\u2019\"]([A-Za-z][A-Za-z'\u2019-]*)['\u2018\u2019\"]", tip)
        words = [w.lower().strip("'-") for w in quoted]
        keep = True
        if words and not all(w in low for w in words):
            keep = False                       # names a word the script never says
        if keep and re.search(r"th sound|\bth\b|/\u03b8/", tip, re.I):
            if words and not any("th" in w for w in words):
                keep = False                   # claims a th in a word without th
            elif not words and "th" not in low:
                keep = False
        # Syllable position cannot be verified from spelling alone, and the
        # model gets it wrong ("ultimately" is stressed on the first, not the
        # second). A guessed stress tip teaches the wrong rhythm.
        if keep and re.search(r"\u91cd\u97f3\u5728\u7b2c[0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d]|"
                              r"[Ss]tress(?:ed)? on the ", tip):
            keep = False
        out.append(tip if keep else "")
    return out


CJK = re.compile(r"[\u4e00-\u9fff]")


def validate(meta: dict):
    problems = []
    lines = meta.get("lines") or []
    script = meta.get("script") or " ".join(l.get("en", "") for l in lines)
    words = len(re.findall(r"[A-Za-z']+", script))
    if not 148 <= words <= 195:
        problems.append(f"script is {words} words, wanted 155-185")
    if not lines:
        problems.append("no lines returned")
    elif not 10 <= len(lines) <= 14:
        problems.append(f"{len(lines)} sentences, wanted 11-13")
    bare = [i + 1 for i, l in enumerate(lines) if not CJK.search(l.get("zh") or "")]
    if bare:
        problems.append(f"no Chinese on sentence(s) {bare[:6]}")
    terms = meta.get("terms") or []
    if not 3 <= len(terms) <= 6:
        problems.append(f"{len(terms)} terms, wanted 3-5")
    thin = [t.get("word", "?") for t in terms if not CJK.search(t.get("zh") or "")]
    if thin:
        problems.append(f"terms without a Chinese gloss: {thin[:4]}")
    if len(meta.get("questions") or []) != 2:
        problems.append("needs exactly 2 questions")
    for q in meta.get("questions") or []:
        if len(q.get("options") or []) != 3 or not 0 <= q.get("answer", -1) < 3:
            problems.append(f"bad question: {q.get('q', '?')[:40]}")
    for g in meta.get("grammar") or []:
        idx = g.get("line")
        if not isinstance(idx, int) or not 1 <= idx <= max(1, len(lines)):
            problems.append(f"grammar points at line {idx}, out of range")
        elif not CJK.search(g.get("note") or ""):
            problems.append(f"grammar note is not Chinese: {str(g.get('point'))[:30]}")
    return problems, words


def normalise(meta: dict):
    """One canonical shape before anything else touches the data.

    Sentences now carry their own translation and tip, so nothing is paired by
    position afterwards — an off-by-one can no longer put a Chinese line under
    the wrong English one.
    """
    lines = []
    for item in meta.get("lines") or []:
        en = (item.get("en") or "").strip()
        if not en:
            continue
        tip = (item.get("focus") or "").strip()
        # Check each tip against its own sentence, not the whole script.
        lines.append({"en": en,
                      "zh": (item.get("zh") or "").strip(),
                      "focus": clean_focus([tip], en)[0]})
    meta["lines"] = lines
    meta["script"] = " ".join(l["en"] for l in lines)
    meta["grammar"] = [g for g in (meta.get("grammar") or [])
                       if isinstance(g.get("line"), int) and 1 <= g["line"] <= len(lines)]
    return meta


def compose_script(story, body):
    """Ask for the script. If the word count misses, say so and ask once more —
    a script that is 25 words short makes the audio feel clipped, and the model
    usually complies when told plainly what it produced."""
    prompt = PROMPT.format(title=story["title"], source=story["source"], body=body)
    meta = normalise(ask_llm(prompt))
    problems, words = validate(meta)
    if not 148 <= words <= 195:
        print(f"  ! {words} words — asking once more with a hard instruction")
        retry = (prompt + f"\n\n---\nYOUR PREVIOUS ATTEMPT WAS {words} WORDS. "
                 "That is outside the required 155-185. Rewrite it as 11 to 13 "
                 "sentences totalling 155-185 words. Keep every fact identical, "
                 "and give every sentence its Chinese translation again.")
        again = normalise(ask_llm(retry))
        problems2, words2 = validate(again)
        if abs(words2 - 170) < abs(words - 170):
            meta, problems, words = again, problems2, words2
    return meta, problems, words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date_cls.today().isoformat())
    ap.add_argument("--url", default=None, help="force a specific article")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.url:
        # Label a manual run by its real outlet, not by "MANUAL" — the source
        # line is shown on the card and in the push message.
        from urllib.parse import urlparse
        host = urlparse(args.url).netloc.replace("www.", "")
        outlet = host.split(".")[0].upper() if host else "MANUAL"
        story = {"source": outlet, "title": page_title(args.url) or args.url,
                 "url": args.url, "body": "", "chars": 0}
        body = article_text({**story, "chars": 0})
    else:
        # Walk down the ranking until a story has enough prose to rewrite.
        # A thin RSS summary is not a failure — it just means try the next one.
        story, body = None, ""
        for cand in pick_story():
            text = article_text(cand)
            if len(text) < 400:
                print(f"  ! {cand['source']}: only {len(text)} chars of body, trying next")
                continue
            if is_off_topic(text):
                print(f"  ! {cand['source']}: reads as entertainment press, trying next")
                continue
            story, body = cand, text
            print(f"\nPicked: {cand['title']}\n  {cand['source']} · {len(text)} chars of body")
            break
        if not story:
            sys.exit("No story had enough body text today. Retry, or pass --url with a full article.")

    if len(body) < 400:
        sys.exit("Article body too short to rewrite. Try --url with the full page.")

    print("Rewriting with LLM...")
    meta, problems, words = compose_script(story, body)

    meta["source"] = story["source"].upper()
    meta["source_url"] = story["url"]
    meta.setdefault("recall_prompts", ["What changed?", "Why does it matter?", "Who is affected?"])

    if problems:
        print("  ! quality checks:")
        for p in problems:
            print("    -", p)

    if args.dry_run:
        print("\n" + "=" * 62)
        print(meta["headline"], f"({words} words)\n")
        for i, line in enumerate(meta["lines"], 1):
            print(f"{i:2}. {line['en']}")
            print(f"    {line['zh'] or '(没有译文)'}")
        print()
        for t in meta["terms"]:
            print(f"· {t['word']} — {t.get('zh', '')}  {t.get('note', '')}")
        for g in meta.get("grammar", []):
            print(f"¶ 第{g['line']}句 {g.get('point')} — {g.get('note')}")
        print("=" * 62)
        return

    CONTENT.mkdir(parents=True, exist_ok=True)
    out = CONTENT / f"{args.date}.json"
    out.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nWrote {out.relative_to(ROOT)} · {words} words · {len(meta['terms'])} terms "
          f"· {len(meta.get('grammar', []))} grammar notes")


if __name__ == "__main__":
    main()
