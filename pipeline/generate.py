#!/usr/bin/env python3
"""
Daily Tech Brief — content builder.

Turns a prepared article script into a practice unit:
  content/<date>.json  ->  app/data/<date>.json + app/audio/<date>-*.mp3

Usage:
  python3 pipeline/generate.py --date 2026-10-24
  python3 pipeline/generate.py --date 2026-10-25 --voice en-US-AvaNeural
  python3 pipeline/generate.py --list-feeds           # print today's candidates

Requires: edge-tts (pip install edge-tts), ffmpeg.
No API key, no paid service. Voice output is Microsoft Neural TTS.
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date as date_cls
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
DATA = ROOT / "data"
AUDIO = ROOT / "audio"

DEFAULT_VOICE = "en-US-AndrewNeural"
DEFAULT_RATE = "-18%"         # slower than news pace, lands near 130 wpm
FALLBACK_SAY_VOICE = "Samantha"

FEEDS = {
    "The Verge": "https://www.theverge.com/rss/index.xml",
    "TechCrunch": "https://techcrunch.com/feed/",
    "Ars Technica": "https://feeds.arstechnica.com/arstechnica/index",
    "MIT Tech Review": "https://www.technologyreview.com/feed/",
}

# stories that make bad listening practice
SKIP_WORDS = ("raises", "funding round", "valuation", "acquires", "IPO",
              "layoffs", "deal of the day", "review:", "hands-on", "best ")


# ---------------------------------------------------------------- text utils

def split_sentences(text: str):
    """Split on sentence boundaries. Keeps abbreviations intact."""
    text = re.sub(r"\s+", " ", text).strip()
    protected = text
    for i, abbr in enumerate(("Mr.", "Ms.", "Dr.", "Prof.", "U.S.", "e.g.", "i.e.", "Inc.", "Corp.")):
        protected = protected.replace(abbr, f"\x00{i}\x00")
    parts = re.split(r"(?<=[.!?])\s+(?=[\"'\u201cA-Z0-9])", protected)
    out = []
    for p in parts:
        p = p.strip()
        for i, abbr in enumerate(("Mr.", "Ms.", "Dr.", "Prof.", "U.S.", "e.g.", "i.e.", "Inc.", "Corp.")):
            p = p.replace(f"\x00{i}\x00", abbr)
        if len(p.split()) >= 3:
            out.append(p)
    return out


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z']+", text))


# ---------------------------------------------------------------- TTS

def tts_edge(text: str, out_mp3: Path, voice: str, rate: str):
    import edge_tts

    async def run():
        comm = edge_tts.Communicate(text, voice, rate=rate)
        await comm.save(str(out_mp3))

    asyncio.run(run())


def tts_say(text: str, out_mp3: Path, wpm: int = 148):
    """Offline fallback when edge-tts is unavailable (needs no network)."""
    aiff = out_mp3.with_suffix(".aiff")
    subprocess.run(["say", "-v", FALLBACK_SAY_VOICE, "-r", str(wpm),
                    "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff),
                    "-codec:a", "libmp3lame", "-qscale:a", "4", str(out_mp3)], check=True)
    aiff.unlink(missing_ok=True)


def speak(text: str, out_mp3: Path, voice: str, rate: str, allow_fallback=True):
    try:
        tts_edge(text, out_mp3, voice, rate)
        if out_mp3.exists() and out_mp3.stat().st_size > 1000:
            return "edge"
    except Exception as exc:                       # noqa: BLE001
        print(f"    edge-tts failed ({exc.__class__.__name__}), falling back to say")
    if not allow_fallback:
        raise RuntimeError("TTS failed")
    tts_say(text, out_mp3)
    return "say"


def duration_seconds(path: Path) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, check=True).stdout.strip()
        return round(float(out), 1)
    except Exception:                              # noqa: BLE001
        return 0.0


def concat_mp3(parts, out_mp3: Path):
    lst = out_mp3.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts), encoding="utf-8")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat",
                    "-safe", "0", "-i", str(lst), "-c", "copy", str(out_mp3)], check=True)
    lst.unlink(missing_ok=True)


# ---------------------------------------------------------------- build

def build(day: str, voice: str, rate: str) -> dict:
    src = CONTENT / f"{day}.json"
    if not src.exists():
        sys.exit(f"missing {src}\nCreate the article script first, then re-run.")

    meta = json.loads(src.read_text(encoding="utf-8"))
    sentences = split_sentences(meta["script"])
    focus = meta.get("focus") or [""] * len(sentences)
    if len(focus) < len(sentences):
        focus += [""] * (len(sentences) - len(focus))

    AUDIO.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)

    print(f"[{day}] {len(sentences)} sentences, {word_count(meta['script'])} words")
    seg_paths, seg_meta = [], []
    for i, (text, tip) in enumerate(zip(sentences, focus), start=1):
        out = AUDIO / f"{day}-s{i}.mp3"
        engine = speak(text, out, voice, rate)
        dur = duration_seconds(out)
        seg_paths.append(out)
        seg_meta.append({
            "id": i,
            "text": text,
            "audio": f"audio/{out.name}",
            "duration": dur,
            "focus": tip,
        })
        print(f"   s{i:<2} {dur:>5.1f}s  {engine:<4}  {text[:58]}")

    full = AUDIO / f"{day}-full.mp3"
    concat_mp3(seg_paths, full)
    total = duration_seconds(full)

    payload = {
        "date": day,
        "source": meta["source"],
        "source_url": meta.get("source_url", ""),
        "headline": meta["headline"],
        "audio": f"audio/{full.name}",
        "duration": total,
        "wpm": round(word_count(meta["script"]) / (total / 60), 1) if total else 0,
        "script": meta["script"],
        "sentences": seg_meta,
        "terms": meta["terms"],
        "questions": meta["questions"],
        "recall_prompts": meta.get("recall_prompts", ["What changed?", "Why does it matter?", "Who is affected?"]),
    }
    (DATA / f"{day}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    rebuild_index()
    print(f"[{day}] done · {total:.0f}s full audio · {payload['wpm']} wpm")
    return payload


def rebuild_index():
    days = []
    for f in sorted(DATA.glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:                          # noqa: BLE001
            continue
        days.append({
            "date": d["date"],
            "headline": d["headline"],
            "source": d["source"],
            "duration": d.get("duration", 0),
            "sentences": len(d.get("sentences", [])),
        })
    days.sort(key=lambda x: x["date"], reverse=True)
    (DATA / "index.json").write_text(
        json.dumps({"updated": datetime.now().isoformat(timespec="seconds"),
                    "days": days}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"index.json · {len(days)} day(s)")


# ---------------------------------------------------------------- feed helper

def list_feeds():
    for name, url in FEEDS.items():
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            root = ET.fromstring(urllib.request.urlopen(req, timeout=20).read())
            items = root.findall(".//item") or [
                e for e in root.iter() if e.tag.endswith("entry")]
            print(f"\n== {name} ==")
            for it in items[:8]:
                title = (it.findtext("title") or "").strip()
                if not title or any(w in title.lower() for w in SKIP_WORDS):
                    continue
                link = it.findtext("link")
                if not link:
                    for child in it:
                        if child.tag.endswith("link") and child.get("href"):
                            link = child.get("href")
                            break
                print(f"  · {title}")
                print(f"    {link}")
        except Exception as exc:                   # noqa: BLE001
            print(f"\n== {name} == FAILED: {exc}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="YYYY-MM-DD (default: today)")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", default=DEFAULT_RATE, help="e.g. -8%% or +0%%")
    ap.add_argument("--list-feeds", action="store_true")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    if args.list_feeds:
        list_feeds()
        return
    if args.reindex:
        rebuild_index()
        return

    day = args.date or date_cls.today().isoformat()
    build(day, args.voice, args.rate)


if __name__ == "__main__":
    main()
