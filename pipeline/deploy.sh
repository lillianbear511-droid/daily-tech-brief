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

rsync -a --delete \
  --include '.env.example' --exclude '.env*' \
  --exclude 'design' --exclude '__pycache__' \
  --exclude '.DS_Store' --exclude '.git' \
  ./ "$WORK/repo/"

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
