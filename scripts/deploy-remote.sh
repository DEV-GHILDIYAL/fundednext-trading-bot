#!/bin/bash
# Runs ON the Ubuntu bot server (piped over SSH by .github/workflows/deploy-bot.yml).
# Manual use on the server:  APP_DIR=~/fundednext-trading-bot BRANCH=main bash scripts/deploy-remote.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/fundednext-trading-bot}"
BRANCH="${BRANCH:-main}"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$APP_DIR"
if [ ! -d .git ]; then
  echo "❌ $APP_DIR is not a git clone — clone the repo there first" >&2
  exit 1
fi

echo "▶ Updating $APP_DIR to origin/$BRANCH"
git fetch --prune origin
PREV=$(git rev-parse HEAD)
git reset --hard "origin/$BRANCH"   # .env, data/ and logs/ are gitignored → untouched
echo "  $PREV → $(git rev-parse HEAD)"

echo "▶ Installing & building"
npm ci --no-audit --no-fund
npm run build

echo "▶ Reloading pm2"
# Open positions are persisted (data/open-trades.json) and keep their SL/TP across the restart
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

echo "▶ Health check"
PORT=$(grep -E '^DASHBOARD_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" > /dev/null; then
    echo "✅ Bot healthy"
    exit 0
  fi
  sleep 3
done
echo "❌ Health check failed — last logs:" >&2
pm2 logs fundednext-bot --lines 40 --nostream || true
exit 1
