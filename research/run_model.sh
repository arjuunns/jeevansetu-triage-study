#!/usr/bin/env bash
# All seven LLM setups (six planned + the exploratory no-notice one) for the
# given models, e.g. MedGemma 27B on the university GPU server. Safe to re-run:
# each run resumes from its results file.
#
#   ollama pull medgemma:27b
#   research/run_model.sh medgemma:27b
#
# Needs data/mimic_ed_cohort.json and research/retrieval_cache.json from this
# repository (the cached excerpts keep RAG identical across machines), and
# OLLAMA_BASE_URL if Ollama is not on localhost:11434.

set -uo pipefail
cd "$(dirname "$0")/../apps/server"

[ $# -eq 0 ] && { echo "usage: research/run_model.sh <model> [<model> ...]" >&2; exit 2; }

run() {
  pnpm exec tsx scripts/evaluate_mimic.ts "$@" || echo "!! run failed: $*" >&2
}

for model in "$@"; do
  run --model="$model" --rag=off --safety=off                       # LLM only
  run --model="$model" --rag=off --safety=on                        # + safety
  run --model="$model" --rag=off --safety=on --safety-notice=off    # + safety, no notice
  run --model="$model" --rag=on  --safety=on                        # full
  run --model="$model" --rag=on  --safety=off                       # + RAG
  run --model="$model" --rag=off --safety=off --guide=on            # + ESI guide
  run --model="$model" --rag=off --safety=on  --guide=on            # + ESI guide + safety
done

python3 -I ../../research/analyze.py
