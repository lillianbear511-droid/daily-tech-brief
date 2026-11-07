# Daily Tech Brief

Two tech stories a day — a morning issue and an evening one — each rewritten into
~170 words of spoken American English, cut into sentences, and played back four ways:
warm up → blind listen → shadow → recall.

Live: https://lillianbear511-droid.github.io/daily-tech-brief/

Install on iPhone: open the link in Safari → Share → Add to Home Screen.
Recording needs HTTPS, which Pages provides. Over a LAN IP the mic is blocked by iOS.

## What is where

```
index.html  app.js  styles.css  sw.js  manifest.json   the app (no build step)
icons/                                                 home screen icons
data/<date>-am.json  data/<date>-pm.json               one practice unit per issue
data/index.json                                        list of issues, newest first
audio/<date>-am-s1.mp3  audio/<date>-am-full.mp3       full audio + one file per sentence
content/<date>-am.json                                 the rewritten script, before TTS
pipeline/slots.py      am/pm slug rules shared by every step
pipeline/compose.py    RSS → pick a story → LLM rewrite
pipeline/generate.py   script → sentences → TTS → data/*.json + audio/
pipeline/push_feishu.py  one card to a Feishu group bot
pipeline/daily.py      all three, in order
pipeline/deploy.sh     publish to GitHub Pages
```

A file named `data/2026-10-24.json` (no slot) is a day from before the evening issue
existed. Everything still reads it: it just has one issue instead of two.

## Three things to fill in

Put them in `.env` at the repo root (never committed):

```
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
```

Then put the same values into GitHub → Settings → Secrets → Actions, so the daily job
can run without your Mac:

```
LLM_API_KEY   FEISHU_WEBHOOK   APP_URL (already set)
```

Feishu webhook: group → Settings → Bots → Add bot → Custom bot → copy the URL.

## Run it

```
python3 -m pip install -r requirements.txt

python3 pipeline/daily.py                    # this hour's issue: pick, rewrite, voice, push
python3 pipeline/daily.py --slot pm          # force the evening issue
python3 pipeline/daily.py --skip-push        # no card, just build it
python3 pipeline/compose.py --dry-run        # see the script before committing to it
bash pipeline/deploy.sh                      # publish
```

`--slot` takes `am`, `pm`, `auto` (default) or `none` for a single daily issue.
`auto` anchors on the target times: 07:00–19:59 builds today's morning issue,
20:00–23:59 today's evening, and 00:00–06:59 is still catching up on yesterday's
evening.

## Daily job

`.github/workflows/daily.yml` runs six times a day — three shots at 07:05, three at
20:05 Asia/Shanghai. Each run picks a story the other issue did not use, rewrites it,
records it, commits, and pushes one card. Nothing runs on your machine.

GitHub's cron is best effort and has started this repo's jobs up to seven hours late.
Two things absorb that: the slot is decided by the target time that most recently
passed rather than by which cron fired, and the retries notice the issue already
exists before they install ffmpeg and quit. A run that catches up on yesterday after
midnight rebuilds the content but stays quiet — no day-old card at 3am.

Re-running is safe: `daily.py` refuses to rebuild an issue that already exists, so the
morning job can never overwrite the evening one.

## Known limits

- **Audio lives in git.** 96 kbps mono, roughly 1.5 MB per issue, ~3 MB a day, ~1 GB a
  year now that there are two. Fine for a year or so; after that, prune `audio/` older
  than 90 days and keep `data/`.
- **iOS kills recording when you leave the screen.** Not fixable. The app says so on the
  record screen.
- **No pronunciation scoring.** You rate each sentence by ear — clear / close / retry.
  Real phoneme scoring needs Azure Pronunciation Assessment, which needs a paid key.
  Fake scores are worse than no scores.
- **One story per issue, chosen by rules.** `SKIP` and `BOOST` in `compose.py` steer it.
  If it keeps picking things you don't care about, edit those two tuples.
