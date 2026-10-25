#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FundedNext bot — full pre-flight check (READ-ONLY: places no orders, changes nothing)
#
#   bash scripts/preflight.sh                 # everything
#   bash scripts/preflight.sh --send-test     # also sends one Telegram test message
#   bash scripts/preflight.sh --no-windows    # skip the SSM check of the Windows host
#
# Run on the Ubuntu server as the ubuntu user, from the repo folder.
# Exit code = number of failed checks (0 = ready).
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 99

SEND_TEST=0; WINDOWS=1
for a in "$@"; do
  case "$a" in
    --send-test) SEND_TEST=1 ;;
    --no-windows) WINDOWS=0 ;;
  esac
done

WIN_ID="${WIN_INSTANCE_ID:-i-00a8b7321c46b1493}"
REGION="${AWS_REGION:-ap-south-1}"
AWS_BIN="$(command -v /usr/local/bin/aws || command -v aws || true)"

PASS=0; WARN=0; FAIL=0
G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; D=$'\e[2m'; N=$'\e[0m'
ok()   { PASS=$((PASS+1)); printf "  ${G}✔${N} %s\n" "$*"; }
warn() { WARN=$((WARN+1)); printf "  ${Y}!${N} %s\n" "$*"; }
bad()  { FAIL=$((FAIL+1)); printf "  ${R}✘${N} %s\n" "$*"; }
info() { printf "    ${D}%s${N}\n" "$*"; }
section() { printf "\n${B}%s${N}\n" "$*"; }

env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
mask() { local v="$1"; [ ${#v} -le 8 ] && echo "****" || echo "${v:0:4}…${v: -4}"; }
# js 'expression using d' <<< json   → prints the result (empty on parse error)
js() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const d=JSON.parse(s);const r=($1);if(r!==undefined)console.log(r)}catch(e){}})"; }

WEEKDAY_UK=$(TZ=Europe/London date +%u)   # 6/7 = weekend
WEEKEND=0; [ "$WEEKDAY_UK" -ge 6 ] && WEEKEND=1

printf "${B}FundedNext bot — pre-flight check${N}  %s IST  (%s)\n" "$(TZ=Asia/Kolkata date '+%a %d %b %H:%M')" "$(hostname)"
[ $WEEKEND -eq 1 ] && info "Weekend: market closed — stale prices / wide spread are expected"

# ── 1. Server ────────────────────────────────────────────────────────────────
section "1. Server"
MEM_AVAIL=$(free -m | awk '/^Mem:/{print $7}'); SWAP=$(free -m | awk '/^Swap:/{print $2}')
[ "${MEM_AVAIL:-0}" -ge 150 ] && ok "RAM available ${MEM_AVAIL} MB" || warn "RAM available only ${MEM_AVAIL} MB"
[ "${SWAP:-0}" -ge 1000 ] && ok "Swap ${SWAP} MB" || warn "Swap ${SWAP:-0} MB (add 2 GB swap to avoid hangs)"
DISK=$(df -P . | awk 'NR==2{print $5}' | tr -d %)
[ "${DISK:-100}" -lt 85 ] && ok "Disk used ${DISK}%" || bad "Disk used ${DISK}% (free some space)"
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then ok "Clock synced (NTP)"; else warn "Clock not reported as NTP-synced (candle timing depends on it)"; fi
info "Uptime: $(uptime -p)"

# ── 2. PM2 process ───────────────────────────────────────────────────────────
section "2. Bot process (PM2)"
if command -v pm2 >/dev/null; then
  PJ=$(pm2 jlist 2>/dev/null)
  STATUS=$(echo "$PJ" | js 'd.find(p=>p.name==="fundednext-bot")?.pm2_env.status')
  RESTARTS=$(echo "$PJ" | js 'd.find(p=>p.name==="fundednext-bot")?.pm2_env.restart_time')
  UP=$(echo "$PJ" | js 'Math.round((Date.now()-d.find(p=>p.name==="fundednext-bot")?.pm2_env.pm_uptime)/60000)')
  [ "$STATUS" = "online" ] && ok "fundednext-bot online (up ${UP} min, restarts ${RESTARTS})" || bad "fundednext-bot status: ${STATUS:-not found}"
  if systemctl is-enabled "pm2-$(whoami)" >/dev/null 2>&1; then ok "PM2 starts on boot (pm2-$(whoami) service)"; else warn "PM2 boot service not found — run: pm2 startup && pm2 save"; fi
  ERRS=$(find ~/.pm2/logs -name 'fundednext-bot-error*.log' -mmin -1440 -exec grep -c "\[ERROR\]" {} + 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')
  [ "${ERRS:-0}" -eq 0 ] && ok "No [ERROR] lines in the last 24 h" || warn "${ERRS} [ERROR] line(s) in the last 24 h — check: pm2 logs fundednext-bot --err --lines 50"
else
  bad "pm2 not installed"
fi

# ── 3. Code & build ──────────────────────────────────────────────────────────
section "3. Code & build"
BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); CM=$(git log -1 --format='%h %s' 2>/dev/null)
info "Branch ${BR} · ${CM}"
git fetch -q 2>/dev/null && BEHIND=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0) || BEHIND="?"
[ "$BEHIND" = "0" ] && ok "Up to date with GitHub" || warn "Behind GitHub by ${BEHIND} commit(s) — git pull && npm run build && pm2 restart fundednext-bot"
if [ -f dist/index.js ]; then
  NEWEST_SRC=$(find src -name '*.ts' -printf '%T@\n' | sort -n | tail -1 | cut -d. -f1)
  DIST=$(stat -c %Y dist/index.js)
  [ "$DIST" -ge "${NEWEST_SRC:-0}" ] && ok "dist/ is built from the current source" || bad "dist/ is older than src/ — run: npm run build && pm2 restart fundednext-bot"
  PM2_START=$(echo "${PJ:-[]}" | js 'Math.round(d.find(p=>p.name==="fundednext-bot")?.pm2_env.pm_uptime/1000)')
  [[ "$PM2_START" =~ ^[0-9]+$ ]] && [ "$PM2_START" -lt "$DIST" ] && warn "Bot was started before the last build — run: pm2 restart fundednext-bot"
else
  bad "dist/index.js missing — run: npm run build"
fi

# ── 4. Configuration (.env) ──────────────────────────────────────────────────
section "4. Configuration (.env)"
[ -f .env ] || { bad ".env missing"; }
DS=$(env_get DATA_SOURCE); DRY=$(env_get DRY_RUN); STRATS=$(env_get STRATEGIES); MAXOPEN=$(env_get MAX_OPEN_POSITIONS)
URL=$(env_get MT5_BRIDGE_URL); TOKEN=$(env_get MT5_BRIDGE_TOKEN)
[ "$DS" = "mt5" ] && ok "DATA_SOURCE=mt5 (real prices)" || bad "DATA_SOURCE=${DS:-unset} (must be mt5)"
if [ "$DRY" = "false" ]; then ok "DRY_RUN=false → real orders on the MT5 account"; else warn "DRY_RUN=${DRY:-true} → paper trades only"; fi
[ -n "$STRATS" ] && ok "STRATEGIES=${STRATS}" || warn "STRATEGIES empty → single STRATEGY=$(env_get STRATEGY)"
info "MAX_OPEN_POSITIONS=${MAXOPEN:-1} · RISK_PERCENT=$(env_get RISK_PERCENT) · MAX_TRADES_PER_DAY=$(env_get MAX_TRADES_PER_DAY) · NEWS_FILTER=$(env_get NEWS_FILTER) · AI_REVIEW_ENABLED=$(env_get AI_REVIEW_ENABLED)"
info "ACCOUNT_BALANCE=$(env_get ACCOUNT_BALANCE) · PHASE_START_DATE=$(env_get PHASE_START_DATE) · CHALLENGE_PHASE=$(env_get CHALLENGE_PHASE)"
[ -n "$URL" ] && ok "MT5_BRIDGE_URL=${URL}" || bad "MT5_BRIDGE_URL unset"
case "$TOKEN" in ""|change_me) bad "MT5_BRIDGE_TOKEN missing/placeholder" ;; *) ok "MT5_BRIDGE_TOKEN set ($(mask "$TOKEN"))" ;; esac
case "$(env_get DASHBOARD_PASSWORD)" in ""|change_me) warn "DASHBOARD_PASSWORD empty/placeholder" ;; *) ok "Dashboard password set" ;; esac

# ── 5. MT5 bridge (Windows) ──────────────────────────────────────────────────
section "5. MT5 bridge & account"
AUTH=(-H "Authorization: Bearer ${TOKEN}")
H=$(curl -s -m 8 "${URL}/health")
if [ -z "$H" ]; then
  bad "Bridge not reachable at ${URL}"
else
  [ "$(echo "$H" | js 'd.ok')" = "true" ] && ok "Bridge healthy" || bad "Bridge /health: $H"
  [ "$(echo "$H" | js 'd.mock')" = "false" ] && ok "Real MT5 (not mock)" || bad "Bridge is in MOCK mode"
  [ "$(echo "$H" | js 'd.tradeAllowed')" = "true" ] && ok "Algo Trading ON in the MT5 terminal" || bad "Algo Trading is OFF in MT5 — orders will be rejected"

  ACC=$(curl -s -m 10 "${AUTH[@]}" "${URL}/account")
  if [ -n "$(echo "$ACC" | js 'd.login')" ]; then
    ok "Account $(echo "$ACC" | js 'd.login') @ $(echo "$ACC" | js 'd.server') · $(echo "$ACC" | js 'd.currency')"
    info "Balance $(echo "$ACC" | js 'd.balance.toFixed(2)') · Equity $(echo "$ACC" | js 'd.equity.toFixed(2)') · Free margin $(echo "$ACC" | js 'd.freeMargin.toFixed(2)') · Leverage 1:$(echo "$ACC" | js 'd.leverage')"
  else
    bad "Bridge /account failed (token wrong?): ${ACC:0:160}"
  fi

  SYM=$(curl -s -m 10 "${AUTH[@]}" "${URL}/symbol/XAUUSD")
  if [ -n "$(echo "$SYM" | js 'd.symbol')" ]; then
    ok "Symbol $(echo "$SYM" | js 'd.symbol') · contract $(echo "$SYM" | js 'd.contractSize') oz · lots $(echo "$SYM" | js 'd.volumeMin')–$(echo "$SYM" | js 'd.volumeMax') step $(echo "$SYM" | js 'd.volumeStep') · digits $(echo "$SYM" | js 'd.digits')"
    SL_MIN=$(echo "$SYM" | js '(d.stopsLevel*d.point).toFixed(2)')
    info "Broker minimum stop distance: \$${SL_MIN} (strategy stops are usually \$5–20)"
  else
    bad "Bridge /symbol/XAUUSD failed: ${SYM:0:160}"
  fi

  TICK=$(curl -s -m 10 "${AUTH[@]}" "${URL}/tick/XAUUSD")
  BID=$(echo "$TICK" | js 'd.bid'); ASK=$(echo "$TICK" | js 'd.ask')
  if [ -n "$BID" ]; then
    SPREAD=$(node -e "console.log(($ASK-$BID).toFixed(2))")
    if [ $WEEKEND -eq 1 ]; then ok "Price ${BID} / ${ASK} (spread \$${SPREAD}, market closed)";
    elif node -e "process.exit(($ASK-$BID)<=0.8?0:1)"; then ok "Price ${BID} / ${ASK} · spread \$${SPREAD}";
    else warn "Price ${BID} / ${ASK} · spread \$${SPREAD} is wide (bot skips above \$0.80)"; fi
  else
    bad "Bridge /tick failed: ${TICK:0:160}"
  fi

  C=$(curl -s -m 15 "${AUTH[@]}" "${URL}/candles/XAUUSD?timeframe=M5&count=300")
  NC=$(echo "$C" | js 'd.candles.length')
  [ "${NC:-0}" -ge 290 ] && ok "M5 candles: ${NC} (last bar $(echo "$C" | js 'd.candles[d.candles.length-1].time.slice(0,16)') server time)" || bad "M5 candles: ${NC:-0} (expected 300)"
  P=$(curl -s -m 10 "${AUTH[@]}" "${URL}/candles/XAUUSD?timeframe=M5&count=5&start=300")
  [ "$(echo "$P" | js 'd.candles.length')" = "5" ] && ok "History paging (?start=) supported" || warn "Bridge ignores ?start= (only needed for fetch-history)"

  POS=$(curl -s -m 10 "${AUTH[@]}" "${URL}/positions")
  NPOS=$(echo "$POS" | js 'd.positions.length')
  [ -n "$NPOS" ] && ok "Open MT5 positions: ${NPOS}" || bad "Bridge /positions failed"
  if [ "${NPOS:-0}" -gt 0 ]; then echo "$POS" | js 'd.positions.map(p=>`    ${p.side} ${p.volume} ${p.symbol} @ ${p.priceOpen} SL ${p.sl} TP ${p.tp} P&L ${p.profit} (magic ${p.magic})`).join("\n")'; fi
fi

# ── 6. Groq AI ───────────────────────────────────────────────────────────────
section "6. Groq AI review"
MODEL=$(env_get GROQ_MODEL); MODEL=${MODEL:-openai/gpt-oss-120b}
for K in GROQ_API_KEY GROQ_API_KEY_2; do
  V=$(env_get $K)
  case "$V" in ""|your_*) warn "$K not set"; continue ;; esac
  CODE=$(curl -s -m 12 -o /tmp/groq-models.json -w '%{http_code}' -H "Authorization: Bearer $V" https://api.groq.com/openai/v1/models)
  if [ "$CODE" = "200" ]; then
    HAS=$(js "d.data.some(m=>m.id===\"$MODEL\")" < /tmp/groq-models.json)
    [ "$HAS" = "true" ] && ok "$K valid ($(mask "$V")) · model ${MODEL} available" || warn "$K valid but model ${MODEL} not listed"
  elif [ "$CODE" = "429" ]; then warn "$K rate-limited right now (429)"
  else bad "$K rejected (HTTP ${CODE})"; fi
done
rm -f /tmp/groq-models.json

# ── 7. Telegram ──────────────────────────────────────────────────────────────
section "7. Telegram"
TT=$(env_get TELEGRAM_BOT_TOKEN); TC=$(env_get TELEGRAM_CHAT_ID)
if [ -z "$TT" ] || [ -z "$TC" ]; then
  warn "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — no alerts"
else
  ME=$(curl -s -m 10 "https://api.telegram.org/bot${TT}/getMe")
  [ "$(echo "$ME" | js 'd.ok')" = "true" ] && ok "Telegram bot @$(echo "$ME" | js 'd.result.username') reachable" || bad "Telegram token rejected"
  CH=$(curl -s -m 10 "https://api.telegram.org/bot${TT}/getChat?chat_id=${TC}")
  [ "$(echo "$CH" | js 'd.ok')" = "true" ] && ok "Chat ${TC} reachable" || bad "Telegram chat ${TC} not reachable (send the bot a message first)"
  if [ $SEND_TEST -eq 1 ]; then
    R=$(curl -s -m 10 "https://api.telegram.org/bot${TT}/sendMessage" -d chat_id="$TC" -d parse_mode=HTML \
      --data-urlencode text="🧪 <b>Pre-flight check</b>"$'\n'"Telegram alerts work. $(TZ=Asia/Kolkata date '+%d %b %H:%M') IST")
    [ "$(echo "$R" | js 'd.ok')" = "true" ] && ok "Test message sent" || bad "Test message failed"
  else
    info "Add --send-test to send one test message"
  fi
fi

# ── 8. External feeds ────────────────────────────────────────────────────────
section "8. News & FX feeds"
NC=$(curl -s -m 10 https://nfs.faireconomy.media/ff_calendar_thisweek.json | js 'd.filter(e=>e.country==="USD"&&e.impact==="High").length')
[ -n "$NC" ] && ok "News calendar reachable (${NC} high-impact USD events this week)" || warn "News calendar unreachable — built-in NFP/CPI/PPI/FOMC dates still apply"
FX=$(curl -s -m 10 https://open.er-api.com/v6/latest/USD | js 'd.rates.INR')
[ -n "$FX" ] && ok "USD/INR rate reachable (₹${FX})" || warn "USD/INR feed unreachable (only affects ₹ display)"

# ── 9. Dashboard & live bot state ────────────────────────────────────────────
section "9. Dashboard & live bot state"
PORT=$(env_get DASHBOARD_PORT); PORT=${PORT:-3000}
DU=$(env_get DASHBOARD_USER); DP=$(env_get DASHBOARD_PASSWORD)
[ "$(curl -s -m 5 "http://127.0.0.1:${PORT}/healthz" | js 'd.ok')" = "true" ] && ok "Dashboard up on port ${PORT}" || bad "Dashboard not responding on port ${PORT}"
S=$(curl -s -m 10 -u "${DU}:${DP}" "http://127.0.0.1:${PORT}/api/status")
if [ -n "$(echo "$S" | js 'd.mode')" ]; then
  ok "Bot mode $(echo "$S" | js 'd.mode') · data $(echo "$S" | js 'd.dataSource') · running $(echo "$S" | js 'd.bot.running')"
  AGE=$(echo "$S" | js 'Math.round((Date.now()-Date.parse(d.bot.lastCycleAt))/1000)')
  [ -n "$AGE" ] && [ "$AGE" -lt 120 ] && ok "Bot loop alive (last cycle ${AGE}s ago)" || bad "Bot loop stale (last cycle ${AGE:-?}s ago)"
  [ "$(echo "$S" | js 'd.bot.dataFeedOk')" = "true" ] && ok "Bot sees the MT5 feed" || bad "Bot reports the MT5 feed as down"
  echo "$S" | js '(d.strategies||[]).map(s=>`    ${s.id}: ${s.window} — ${s.status}`).join("\n")'
  [ -n "$(echo "$S" | js 'd.apiVersion')" ] && info "Dashboard API v$(echo "$S" | js 'd.apiVersion') · open trades $(echo "$S" | js 'd.openTrades.length') · phase P&L \$$(echo "$S" | js 'd.challenge?.profit')"
  FIB=$(echo "$S" | js 'd.fib ? `Fib levels ${d.fib.date}: SHORT ${d.fib.upper} · LONG ${d.fib.lower} (range ${d.fib.range})` : ""')
  [ -n "$FIB" ] && info "$FIB"
  BLK=$(echo "$S" | js 'd.news?.blackout||""'); [ -n "$BLK" ] && warn "$BLK"
else
  bad "Dashboard /api/status failed (password?)"
fi

# ── 10. Windows host (via SSM) ───────────────────────────────────────────────
section "10. Windows host (MT5 terminal + bridge task)"
if [ $WINDOWS -eq 0 ]; then
  info "skipped (--no-windows)"
elif [ -z "$AWS_BIN" ]; then
  warn "aws CLI not found — skipped"
else
  CMDS='{"commands":["$t=Get-Process terminal64 -ErrorAction SilentlyContinue; if($t){\"MT5_TERMINAL=running pid=\"+$t[0].Id}else{\"MT5_TERMINAL=missing\"}; $k=Get-ScheduledTask -TaskName MT5Bridge -ErrorAction SilentlyContinue; \"BRIDGE_TASK=\"+$k.State; $u=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*uvicorn app:app*\" }; if($u){\"UVICORN=running\"}else{\"UVICORN=missing\"}; $s=query user 2>$null; if($s -match \"Active\"){\"SESSION=active\"}else{\"SESSION=\"+($s -join \" \")}; $os=Get-CimInstance Win32_OperatingSystem; \"FREE_RAM_MB=\"+[int]($os.FreePhysicalMemory/1024); \"UPTIME_H=\"+[int]((Get-Date)-$os.LastBootUpTime).TotalHours"]}'
  echo "$CMDS" > /tmp/preflight-win.json
  CID=$($AWS_BIN ssm send-command --region "$REGION" --instance-ids "$WIN_ID" --document-name AWS-RunPowerShellScript \
        --parameters file:///tmp/preflight-win.json --query Command.CommandId --output text 2>/tmp/preflight-aws.err)
  if [ -z "$CID" ]; then
    warn "SSM command failed: $(head -c 160 /tmp/preflight-aws.err)"
  else
    OUT=""; for i in $(seq 1 20); do
      sleep 3
      ST=$($AWS_BIN ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$WIN_ID" --query Status --output text 2>/dev/null)
      case "$ST" in Success|Failed|Cancelled|TimedOut) OUT=$($AWS_BIN ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$WIN_ID" --query StandardOutputContent --output text); break ;; esac
    done
    if [ -z "$OUT" ]; then warn "Windows check did not finish in 60 s (status ${ST:-?})"; else
      echo "$OUT" | grep -q "MT5_TERMINAL=running" && ok "MT5 terminal running" || bad "MT5 terminal NOT running on Windows"
      echo "$OUT" | grep -q "UVICORN=running" && ok "Bridge process running" || bad "Bridge process not found"
      echo "$OUT" | grep -q "BRIDGE_TASK=Running" && ok "MT5Bridge scheduled task running" || warn "MT5Bridge task: $(echo "$OUT" | grep BRIDGE_TASK | cut -d= -f2)"
      echo "$OUT" | grep -q "SESSION=active" && ok "Administrator session logged on (needed for MT5)" || warn "Windows session: $(echo "$OUT" | grep SESSION | cut -d= -f2-) — MT5 needs a logged-on session"
      info "Windows free RAM $(echo "$OUT" | grep FREE_RAM_MB | cut -d= -f2) MB · uptime $(echo "$OUT" | grep UPTIME_H | cut -d= -f2) h"
    fi
  fi
  rm -f /tmp/preflight-win.json /tmp/preflight-aws.err
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf "\n${B}Result:${N} ${G}%d passed${N} · ${Y}%d warnings${N} · ${R}%d failed${N}\n" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -eq 0 ]; then printf "${G}${B}READY${N} — the bot can trade.\n"; else printf "${R}${B}NOT READY${N} — fix the ✘ items above.\n"; fi
exit "$FAIL"
