#!/usr/bin/env bash
# Task 6 (8-bit check), 19 Nov 2026. /workspace had 23 GB free and the 8-bit Gemma 3 27B build
# (gemma3:27b-it-q8_0) needs 29.6 GB: the small models were deleted, but the NFS share keeps deleted
# files in its snapshots. With the user's approval the 8-bit model is kept on the server's local
# disk (/root/ollama-models-q8) and served by a second Ollama server on 127.0.0.1:11537, with the same
# Ollama 0.32.14 binary and the same settings (OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1,
# temperature 0, seed 42, context 8192). Only the storage path differs.
#
# The script waits until the main queue (run_ext.sh, port 11535) has finished and released its lock,
# unloads whatever model the main server still holds, so that only one model is on the GPU, and then
# runs research/results_ext/queue_precision.tsv through run_ext.sh on port 11537.
#
#   nohup bash research/run_precision.sh &      # log: research/results_ext/logs/run_precision.log

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/research/results_ext"
exec >> "$EXT/logs/run_precision.log" 2>&1
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

log "waiting for the main queue (run_ext.sh on port 11535) to finish"
flock "$EXT/.run_ext.lock" true
log "main queue finished"

loaded() { curl -fsS -m 10 "http://127.0.0.1:$1/api/ps" | python3 -c 'import json, sys; [print(m["name"]) for m in json.load(sys.stdin)["models"]]'; }
for m in $(loaded 11535); do
  curl -fsS -m 60 http://127.0.0.1:11535/api/generate -d "{\"model\": \"$m\", \"keep_alive\": 0}" > /dev/null
  log "unloaded $m from port 11535"
done
sleep 15
if [ -n "$(loaded 11535)" ]; then
  log "STOP: port 11535 still has a model loaded: $(loaded 11535)"
  exit 1
fi

export OLLAMA_MODELS_DIR=/root/ollama-models-q8
QUEUE="$EXT/queue_precision.tsv" OLLAMA_PORT=11537 bash "$ROOT/research/run_ext.sh"
log "precision queue finished"
