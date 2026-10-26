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
import shutil
import subprocess
import sys
import tempfile
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

# edge-tts can only return audio-24khz-48kbitrate-mono-mp3 from the free
# endpoint, and at that rate the sibilants quantise into a hiss that reads as
# electrical noise on a phone speaker. We cannot ask for a better format, so
# every clip is rebuilt at 44.1 kHz / 96 kbps: the upsampled stream gives the
# decoder room to work and stops a second layer of artefacts being added.
OUT_SR = 44100
OUT_BITRATE = "96k"
GAP_MS = 220                  # breath between sentences, in the full audio only
FADE = 0.01                   # kills the clicks at each clip's first sample

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


def _ffmpeg(args):
    proc = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip()[:300]}")


def _to_wav(raw: Path, wav: Path):
    """Raw TTS clip -> clean 44.1 kHz mono PCM, faded at both ends."""
    _ffmpeg(["-i", str(raw),
             "-af", (f"highpass=f=70,"
                     f"afade=t=in:st=0:d={FADE},"
                     f"areverse,afade=t=in:st=0:d={FADE},areverse"),
             "-ar", str(OUT_SR), "-ac", "1", "-c:a", "pcm_s16le", str(wav)])


def _silence_wav(wav: Path):
    _ffmpeg(["-f", "lavfi", "-i", f"anullsrc=r={OUT_SR}:cl=mono",
             "-t", f"{GAP_MS / 1000}", "-c:a", "pcm_s16le", str(wav)])


def _wav_to_mp3(wav: Path, mp3: Path):
    _ffmpeg(["-i", str(wav), "-c:a", "libmp3lame", "-b:a", OUT_BITRATE,
             "-ar", str(OUT_SR), "-ac", "1", str(mp3)])


def join_wavs(wavs, out_mp3: Path):
    """Join prepared PCM clips with a short breath between, encode once.

    Never copy mp3 frames to do this: each clip's encoder padding survives a
    copy and lands on the next sentence as a click.
    """
    work = Path(tempfile.mkdtemp(prefix="dtb-"))
    try:
        silence = work / "gap.wav"
        _silence_wav(silence)
        seq = []
        for i, w in enumerate(wavs):
            if i:
                seq.append(silence)
            seq.append(w)
        args = []
        for p in seq:
            args += ["-i", str(p)]
        chain = "".join(f"[{i}:a]" for i in range(len(seq)))
        args += ["-filter_complex", f"{chain}concat=n={len(seq)}:v=0:a=1[out]",
                 "-map", "[out]", "-c:a", "pcm_s16le",
                 "-ar", str(OUT_SR), "-ac", "1", str(work / "joined.wav")]
        _ffmpeg(args)
        _wav_to_mp3(work / "joined.wav", out_mp3)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- build

def build(day: str, voice: str, rate: str) -> dict:
    src = CONTENT / f"{day}.json"
    if not src.exists():
        sys.exit(f"missing {src}\nCreate the article script first, then re-run.")

    meta = json.loads(src.read_text(encoding="utf-8"))
    lines = normalise_lines(meta)
    script = meta.get("script") or " ".join(l["en"] for l in lines)
    words = word_count(script)

    AUDIO.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)

    print(f"[{day}] {len(lines)} sentences, {words} words")
    rawdir = Path(tempfile.mkdtemp(prefix="dtb-say-"))
    seg_meta, wavs = [], []
    try:
        for i, line in enumerate(lines, start=1):
            raw = rawdir / f"s{i}.mp3"
            engine = speak(line["en"], raw, voice, rate)
            wav = rawdir / f"s{i}.wav"
            _to_wav(raw, wav)              # 44.1 kHz, faded, clipped clean
            wavs.append(wav)
            out = AUDIO / f"{day}-s{i}.mp3"
            _wav_to_mp3(wav, out)
            dur = duration_seconds(out)
            seg_meta.append({
                "id": i,
                "text": line["en"],
                "zh": line["zh"],
                "audio": f"audio/{out.name}",
                "duration": dur,
                "focus": line["focus"],
            })
            print(f"   s{i:<2} {dur:>5.1f}s  {engine:<4}  {line['en'][:52]}")
        # Join while the PCM clips still exist — they are the source of truth,
        # the per-sentence mp3s are just what the phone streams.
        full = AUDIO / f"{day}-full.mp3"
        join_wavs(wavs, full)
    finally:
        shutil.rmtree(rawdir, ignore_errors=True)

    total = duration_seconds(full)

    payload = {
        "date": day,
        "source": meta["source"],
        "source_url": meta.get("source_url", ""),
        "headline": meta["headline"],
        "audio": f"audio/{full.name}",
        "duration": total,
        "wpm": round(words / (total / 60), 1) if total else 0,
        "script": script,
        "sentences": seg_meta,
        "terms": meta.get("terms", []),
        "grammar": meta.get("grammar", []),
        "questions": meta.get("questions", []),
        "recall_prompts": meta.get("recall_prompts", ["What changed?", "Why does it matter?", "Who is affected?"]),
    }
    (DATA / f"{day}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    rebuild_index()
    print(f"[{day}] done · {total:.0f}s full audio · {payload['wpm']} wpm")
    return payload


def normalise_lines(meta: dict):
    """One shape for every day, old files included.

    New scripts arrive as `lines: [{en, zh, focus}]`, which keeps translation
    and tip glued to the sentence they belong to. Older files only have a
    `script` paragraph plus a parallel `focus` list, so fall back to splitting
    and zipping — never silently lose a sentence.
    """
    lines = []
    for item in meta.get("lines") or []:
        en = (item.get("en") or "").strip()
        if not en:
            continue
        lines.append({"en": en,
                      "zh": (item.get("zh") or "").strip(),
                      "focus": (item.get("focus") or "").strip()})
    if lines:
        return lines

    sentences = split_sentences(meta.get("script", ""))
    focus = meta.get("focus") or []
    zh = meta.get("translation") or []
    return [{"en": s,
             "zh": zh[i].strip() if i < len(zh) else "",
             "focus": focus[i].strip() if i < len(focus) else ""}
            for i, s in enumerate(sentences)]


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
