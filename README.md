# Daily Tech Brief

One tech story a day, rewritten into ~170 words of spoken American English, cut into
sentences, and played back four ways: warm up → blind listen → shadow → recall.

Live: https://lillianbear511-droid.github.io/daily-tech-brief/

Install on iPhone: open the link in Safari → Share → Add to Home Screen.
Recording needs HTTPS, which Pages provides. Over a LAN IP the mic is blocked by iOS.

## What is where

```
index.html  app.js  styles.css  sw.js  manifest.json   the app (no build step)
icons/                                                 home screen icons
data/<date>.json  data/index.json                      one practice unit per day
audio/<date>-*.mp3                                     full audio + one file per sentence
content/<date>.json                                    the rewritten script, before TTS
pipeline/compose.py    RSS → pick a story → LLM rewrite
pipeline/generate.py   script → sentences → TTS → data/*.json + audio/
pipeline/push_feishu.py  one card to a Feishu group bot
pipeline/daily.py      all three, in order
pipeline/deploy.sh     publish to GitHub Pages
```

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

python3 pipeline/daily.py                    # today: pick, rewrite, voice, push
python3 pipeline/daily.py --skip-push        # no card, just build the day
python3 pipeline/compose.py --dry-run        # see the script before committing to it
bash pipeline/deploy.sh                      # publish
```

## Daily job

`.github/workflows/daily.yml` runs at 07:05 Asia/Shanghai: pick → rewrite → voice →
commit → push card. Nothing runs on your machine.

GitHub cron is UTC and sometimes starts a few minutes late. If the card is landing too
late or too early, edit the `cron:` line.

## Known limits

- **Audio lives in git.** 48 kbps mono, roughly 0.8 MB per day, ~290 MB per year. Fine
  for a year; after that, prune `audio/` older than 90 days and keep `data/`.
- **iOS kills recording when you leave the screen.** Not fixable. The app says so on the
  record screen.
- **No pronunciation scoring.** You rate each sentence by ear — clear / close / retry.
  Real phoneme scoring needs Azure Pronunciation Assessment, which needs a paid key.
  Fake scores are worse than no scores.
- **One story per day, chosen by rules.** `SKIP` and `BOOST` in `compose.py` steer it.
  If it keeps picking things you don't care about, edit those two tuples.
