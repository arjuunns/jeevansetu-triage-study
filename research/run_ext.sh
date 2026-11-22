#!/usr/bin/env bash
# Runs the extension experiments (branch experiments-v3, 16 Nov 2026) one after another on the GPU
# server, from a queue file. Resumable: a finished run is skipped, an unfinished one is resumed by
# evaluate_mimic.ts from its --out file. Never uses --fresh and never writes outside
# research/results_ext/.
#
#   tmux new -d -s ext 'bash research/run_ext.sh'        # start (or restart) the queue
#   tail -f research/results_ext/logs/run_ext.log         # follow it
#
# Queue: research/results_ext/queue.tsv, one run per line:
#   <output file under research/results_ext/><TAB><evaluate_mimic.ts arguments>
# Lines starting with # are ignored. Lines may be added while the queue is running; the file is
# read again after every run. The queue stops when every line is finished or has failed twice.
#
# Same settings as the paper for every run (temperature 0 and seed 42 are evaluate_mimic.ts
# defaults; context 8192): the Ollama 0.32.14 binary that run_gpu.sh installed, served on
# 127.0.0.1:11535 with OLLAMA_MODELS=/workspace/ollama-models, OLLAMA_NUM_PARALLEL=1 and
# OLLAMA_MAX_LOADED_MODELS=1. A run in which no case finishes for STALL_MINUTES (30) is stopped
# and tried once more; if it stalls again it is reported in problems.log and the queue moves on.
#
# Handbook cases are not run before the pre-registration is pushed: any line that names
# data/esi_handbook_cases.json is refused until research/results_ext/.handbook_confirmed exists.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/apps/server"
EXT="$ROOT/research/results_ext"
QUEUE="${QUEUE:-$EXT/queue.tsv}"
LOGS="$EXT/logs"
LOG="$LOGS/run_ext.log"
PROBLEMS="$EXT/problems.log"
TSX="$SERVER/node_modules/.bin/tsx"
OLLAMA_BIN="${OLLAMA_BIN:-$HOME/.cache/jeevansetu/ollama-0.32.14/bin/ollama}"
OLLAMA_PORT="${OLLAMA_PORT:-11535}"
OLLAMA_URL="http://127.0.0.1:$OLLAMA_PORT"
STALL_MINUTES="${STALL_MINUTES:-30}"
EXPECT_OLLAMA="0.32.14"

mkdir -p "$LOGS"
exec > >(tee -a "$LOG") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

exec 9> "$EXT/.run_ext.lock"
if ! flock -n 9; then
  log "Another run_ext.sh is already running; not starting a second one."
  exit 0
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://unused:unused@127.0.0.1:5432/unused}"
export OLLAMA_NUM_CTX=8192
export OLLAMA_BASE_URL="$OLLAMA_URL"
export LOG_LEVEL="${LOG_LEVEL:-info}"

kill_tree() {
  local p=$1 c
  for c in $(ps -eo pid=,ppid= | awk -v p="$p" '$2 == p { print $1 }'); do kill_tree "$c"; done
  kill -TERM "$p" 2>/dev/null
}
CURRENT_PID=""
trap '[ -n "$CURRENT_PID" ] && kill_tree "$CURRENT_PID"; log "Interrupted. Start the script again to resume."; exit 130' INT TERM HUP

api_version() { curl -fsS -m 5 "$OLLAMA_URL/api/version" 2>/dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])' 2>/dev/null; }

ensure_ollama() {
  local v
  v="$(api_version)"
  if [ -z "$v" ]; then
    log "Ollama is not answering on port $OLLAMA_PORT: starting it (log: research/results_ext/logs/ollama.log)"
    OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" OLLAMA_MODELS=/workspace/ollama-models OLLAMA_KEEP_ALIVE=2h \
      OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 \
      nohup setsid "$OLLAMA_BIN" serve >> "$LOGS/ollama.log" 2>&1 < /dev/null &
    for _ in $(seq 1 60); do v="$(api_version)"; [ -n "$v" ] && break; sleep 1; done
  fi
  [ "$v" = "$EXPECT_OLLAMA" ] || { log "STOP: Ollama on port $OLLAMA_PORT is '$v', expected $EXPECT_OLLAMA"; exit 1; }
}

# 0 = finished without errors, 1 = not finished or has error cases, 2 = no file.
STATUS_PY='
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    print("no result file"); sys.exit(2)
c = d["counts"]
print("%d of %d cases (ok %d, fallback %d, error %d)%s" % (c["done"], c["total"], c["ok"], c["fallback"], c["error"], "" if d["complete"] else ", not finished"))
sys.exit(0 if d["complete"] and c["error"] == 0 else 1)
'
status() { python3 -c "$STATUS_PY" "$1"; }

# Runs one evaluate_mimic.ts command; returns 2 if it stalled.
run_eval() {
  local rlog=$1
  shift
  (cd "$SERVER" && exec "$TSX" scripts/evaluate_mimic.ts "$@") >> "$rlog" 2>&1 &
  CURRENT_PID=$!
  local seen size last_change rc
  seen=$(wc -c < "$rlog")
  last_change=$(date +%s)
  while kill -0 "$CURRENT_PID" 2>/dev/null; do
    sleep 10
    size=$(wc -c < "$rlog")
    if [ "$size" -gt "$seen" ]; then
      seen=$size
      last_change=$(date +%s)
    elif [ $(($(date +%s) - last_change)) -ge $((STALL_MINUTES * 60)) ]; then
      log "!! No case finished for $STALL_MINUTES minutes: stopping this run."
      kill_tree "$CURRENT_PID"
      wait "$CURRENT_PID" 2>/dev/null
      CURRENT_PID=""
      return 2
    fi
  done
  wait "$CURRENT_PID"
  rc=$?
  CURRENT_PID=""
  return $rc
}

declare -A FAILED=()
log "=== run_ext.sh on $(hostname), queue $QUEUE ==="
ensure_ollama

while :; do
  did_one=""
  while IFS=$'\t' read -r out args; do
    case "$out" in '' | \#*) continue ;; esac
    case "$out" in research/results_ext/*) ;; *) log "!! Skipping '$out': output must be under research/results_ext/"; continue ;; esac
    case "$args" in *--fresh*) log "!! Skipping '$out': --fresh is not allowed"; continue ;; esac
    if [[ "$args" == *esi_handbook_cases.json* ]] && [ ! -f "$EXT/.handbook_confirmed" ]; then
      continue  # waits for the pre-registration push
    fi
    [ -n "${FAILED[$out]:-}" ] && continue
    status "$ROOT/$out" > /dev/null 2>&1 && continue

    ensure_ollama
    # A model that is still being pulled: wait for it (up to 2 hours) instead of failing the run.
    model="$(printf '%s\n' $args | sed -n 's/^--model=//p')"
    for _ in $( [ -n "$model" ] && seq 1 120 ); do
      curl -fsS -m 30 "$OLLAMA_URL/api/tags" | python3 -c 'import json, sys; m = sys.argv[1]; sys.exit(0 if any(x["name"] in (m, m + ":latest") for x in json.load(sys.stdin)["models"]) else 1)' "$model" && break
      log "waiting for $model to be pulled"
      sleep 60
    done
    python3 -I "$ROOT/research/run_info_ext.py" $args > /dev/null 2>> "$LOG" || log "WARNING: could not update run_info.json"
    name="$(basename "$out" .json)"
    rlog="$LOGS/$(date +%Y%m%d-%H%M%S)_$(basename "$(dirname "$out")")_$name.log"
    : > "$rlog"
    log "START $out   [$args]"
    for attempt in 1 2; do
      # shellcheck disable=SC2086
      run_eval "$rlog" $args --out="$ROOT/$out"
      rc=$?
      status "$ROOT/$out" > /dev/null 2>&1 && break
      [ "$attempt" -eq 1 ] && log "$out: not finished (exit code $rc, last log lines below), trying once more" && tail -3 "$rlog"
    done
    if s="$(status "$ROOT/$out")"; then
      log "DONE  $out: $s"
    else
      log "FAIL  $out: $s (exit code $rc; log $rlog)"
      printf '[%s] %s: %s (exit code %s; log %s)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$out" "$s" "$rc" "$rlog" >> "$PROBLEMS"
      FAILED[$out]=1
    fi
    did_one=yes
    break  # read the queue again from the top, so added lines and their order are respected
  done < "$QUEUE"
  [ -z "$did_one" ] && break
done

log "=== Queue finished: nothing left to run (${#FAILED[@]} failed) ==="
