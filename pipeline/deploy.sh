#!/usr/bin/env bash
# Publish the current build to GitHub Pages. One command, no prompts.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="lillianbear511-droid/daily-tech-brief"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# git in this environment points at a local proxy that is not always running.
# Try direct first, fall back to the proxy.
git_net() {
  git -c http.proxy= -c https.proxy= "$@" 2>/dev/null && return 0
  git "$@" 2>/dev/null && return 0
  return 1
}

echo "cloning $REPO"
git_net clone -q "https://github.com/$REPO.git" "$WORK/repo" \
  || { echo "cannot reach github.com (direct and proxy both failed)"; exit 1; }

# Two passes on purpose.
#
# Pass 1 copies the generative folders without --delete. Those are written by
# two different machines: this laptop when you regenerate an issue by hand, and
# the GitHub runner twice a day. A plain --delete would remove an issue the
# runner produced but this laptop has not downloaded yet — that is how the
# morning brief silently disappeared once.
rsync -a \
  --include '.env.example' --exclude '.env*' \
  --exclude 'design' --exclude '__pycache__' \
  --exclude '.DS_Store' --exclude '.git' \
  ./data ./audio ./content "$WORK/repo/"

# Pass 2 makes code authoritative: html/css/js/pipeline/workflow must match
# this folder exactly, so deleted files really disappear. The three generative
# folders are excluded from deletion, which is what keeps pass 1's additions.
rsync -a --delete \
  --include '.env.example' --exclude '.env*' \
  --exclude 'data' --exclude 'audio' --exclude 'content' \
  --exclude 'design' --exclude '__pycache__' \
  --exclude '.DS_Store' --exclude '.git' \
  ./ "$WORK/repo/"

# index.json is derived, never authored. Rebuilding it here from whatever issue
# files ended up in the clone means the homepage always lists the union of
# what this laptop and the runner produced, instead of whichever copy of
# index.json happened to be newer. Issue files are named <date>-am / <date>-pm,
# and files from before the evening issue existed are named just <date>.
python3 - "$WORK/repo/data" <<'PY'
import json, re, sys
from datetime import datetime
from pathlib import Path

data = Path(sys.argv[1])
days = []
for f in sorted(data.glob("*.json")):
    if f.name == "index.json":
        continue
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        continue
    slug = d.get("id") or f.stem
    m = re.match(r"^(\d{4}-\d{2}-\d{2})(?:-(am|pm))?$", slug)
    if not m:
        continue
    days.append({"id": slug,
                 "date": m.group(1),
                 "slot": m.group(2) or "",
                 "headline": d["headline"],
                 "source": d["source"],
                 "duration": d.get("duration", 0),
                 "sentences": len(d.get("sentences", []))})
# Newest first; inside one day the evening issue is the later one.
days.sort(key=lambda x: (x["date"], x["slot"]), reverse=True)
(data / "index.json").write_text(
    json.dumps({"updated": datetime.now().isoformat(timespec="seconds"),
                "days": days}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"index rebuilt · {len(days)} issue(s)")
PY

cd "$WORK/repo"
git add -A
if git diff --cached --quiet; then
  echo "nothing new to publish"
  exit 0
fi
git -c user.name="daily-brief" -c user.email="bot@users.noreply.github.com" \
    commit -q -m "publish $(date +%Y-%m-%d\ %H:%M)"
git_net push -q origin main || { echo "push failed — check network, then re-run"; exit 1; }
echo "published -> https://lillianbear511-droid.github.io/daily-tech-brief/"
