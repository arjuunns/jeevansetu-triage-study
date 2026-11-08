#!/usr/bin/env bash
# Runs queued after run_ablation.sh. Safe to re-run: each run resumes.
#
# 1. Exploratory (added after the first qwen results showed safety-on raised
#    under-triage): safety rules and override as usual, but no "no critical red
#    flags" notice when no rule fires. For the two main models.
# 2. More models through every condition plus the exploratory one: the main
#    contrasts for all models first, so an interrupted run still leaves them.
#    medgemma:4b was planned but dropped (research/medgemma_probe/README.md).
#
#   research/run_extra.sh               # default: gemma3:12b
#   research/run_extra.sh <model> ...   # other models

set -uo pipefail
cd "$(dirname "$0")/../apps/server"

MODELS=("$@")
[ ${#MODELS[@]} -eq 0 ] && MODELS=(gemma3:12b)

run() {
  pnpm exec tsx scripts/evaluate_mimic.ts "$@" || echo "!! run failed: $*" >&2
}

for model in qwen2.5:7b llama3.1:8b; do
  run --model="$model" --rag=off --safety=on --safety-notice=off
done

for model in "${MODELS[@]}"; do
  run --model="$model" --rag=off --safety=off                       # LLM only
  run --model="$model" --rag=off --safety=on                        # + safety
  run --model="$model" --rag=off --safety=on --safety-notice=off    # + safety, no notice
  run --model="$model" --rag=on  --safety=on                        # full
done

for model in "${MODELS[@]}"; do
  run --model="$model" --rag=on  --safety=off                       # + RAG
  run --model="$model" --rag=off --safety=off --guide=on            # + ESI guide
  run --model="$model" --rag=off --safety=on  --guide=on            # + ESI guide + safety
done

python3 -I ../../research/analyze.py
