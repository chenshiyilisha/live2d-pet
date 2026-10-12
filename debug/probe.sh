#!/usr/bin/env bash
# 跑一次 ?snap=ink 取景标定：把模型压到完整可见，量墨水包围盒。
# 用法： ./debug/probe.sh <pet> <pad> <logname> [extraQuery]
# 例：   ./debug/probe.sh 0.40 25 m1
set -u
cd "$(dirname "$0")/.." || exit 1

PET="$1"; PAD="$2"; NAME="$3"; EXTRA="${4:-}"
LOG="debug/${NAME}.log"
PNG="debug/${NAME}.png"

: > "$LOG"
unset ELECTRON_RUN_AS_NODE
PET_SNAPSHOT="ink&pet=${PET}&pad=${PAD}${EXTRA}" \
  ./node_modules/electron/dist/electron.exe . >"$LOG" 2>&1 &
PID=$!

# 等 "ink done"（渲染层跑满 32s），最多 70s
for _ in $(seq 1 70); do
  sleep 1
  if grep -qa 'ink done' "$LOG"; then break; fi
done

cp -f debug/pet-window.png "$PNG" 2>/dev/null
kill "$PID" 2>/dev/null
sleep 1
taskkill //F //IM electron.exe >/dev/null 2>&1
echo "--- $NAME pet=$PET pad=$PAD ---"
grep -aE '\[pet\] layout|\[pet\] ink done' "$LOG" | sed 's/^\[renderer\] .*"message"://' | tail -4
