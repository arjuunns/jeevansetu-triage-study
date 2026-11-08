#!/usr/bin/env bash
# Full ablation: the rules-only baseline, then six LLM conditions per model,
# then the statistics. Safe to re-run: each LLM run resumes where it stopped.
#
#   research/run_ablation.sh                         # default models
#   research/run_ablation.sh llama3.1:8b qwen2.5:7b  # chosen models
#
# Needs: `ollama serve` running with the models pulled, and
# research/retrieval_cache.json (pnpm --filter @jeevansetu/server mimic:retrieval-cache).

set -uo pipefail
cd "$(dirname "$0")/../apps/server"

MODELS=("$@")
[ ${#MODELS[@]} -eq 0 ] && MODELS=(qwen2.5:7b llama3.1:8b)

run() {
  pnpm exec tsx scripts/evaluate_mimic.ts "$@" || echo "!! run failed: $*" >&2
}

run --rules-only --fresh   # instant, so always recomputed

# Every condition of one model before the next, so an interrupted night still
# leaves complete ablations for the first models.
for model in "${MODELS[@]}"; do
  run --model="$model" --rag=off --safety=off                # LLM only
  run --model="$model" --rag=off --safety=on                 # + safety
  run --model="$model" --rag=off --safety=off --guide=on     # + ESI guide
  run --model="$model" --rag=off --safety=on  --guide=on     # + ESI guide + safety
  run --model="$model" --rag=on  --safety=off                # + RAG
  run --model="$model" --rag=on  --safety=on                 # full
done

python3 -I ../../research/analyze.py
