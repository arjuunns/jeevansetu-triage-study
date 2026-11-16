#!/usr/bin/env bash
# Pipeline v2 (9 Nov 2026): reruns every setup that uses the ESI guide or retrieval, after
#   * the ESI guide was corrected against the ESI v4 handbook (2012 edition): decision point A
#     lists all seven ESI 1 criteria including acute mental status changes; paediatric fever
#     criteria joined with "or";
#   * the ESI v5 handbook in the retrieval corpus was replaced by chapters 2-6 and Appendix B
#     of the ESI v4 handbook (medical-pdf/ingestion/local_ingest.py, no cloud calls);
#   * the Gemini reranker was replaced by the local bge-reranker-v2-m3 cross-encoder
#     (research/retrieval_cache.v2.json, built with --rerank=local).
# Setups without guide or retrieval (LLM only, + safety, + safety no notice) are unchanged and
# not rerun. The v1 results of the rerun setups are kept in research/results_v1/.
#
#   research/run_v2.sh                 # qwen2.5:7b llama3.1:8b gemma3:12b
#   research/run_v2.sh <model> ...

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/server"
CACHE="$ROOT/research/retrieval_cache.v2.json"
[ -f "$CACHE" ] || { echo "missing $CACHE: build it with --rerank=local first" >&2; exit 1; }

MODELS=("$@")
[ ${#MODELS[@]} -eq 0 ] && MODELS=(qwen2.5:7b llama3.1:8b gemma3:12b)

run() {
  pnpm exec tsx scripts/evaluate_mimic.ts "$@" || echo "!! run failed: $*" >&2
}

# Hash of the corrected guide, as evaluate_mimic.ts records it (sha256, first 16 hex characters).
GUIDE_SHA=$(pnpm exec tsx -e "import {ESI_ALGORITHM_GUIDE as G} from './src/modules/triage/esi.guide.ts'; import c from 'crypto'; process.stdout.write(c.createHash('sha256').update(G).digest('hex').slice(0,16))")

# Move a v1 result (old guide or old retrieval cache) out of research/results/ before its v2 rerun.
archive() {
  python3 -I - "$ROOT/research/results/$1.json" "$ROOT/research/results_v1" "$GUIDE_SHA" <<'PY'
import json, shutil, sys
from pathlib import Path
f, dest, sha = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
if f.exists():
    c = json.loads(f.read_text())["config"]
    old_guide = c.get("esiGuideSha256") not in (None, sha)
    old_cache = c.get("useRag") and c.get("retrievalCache") != "research/retrieval_cache.v2.json"
    if old_guide or old_cache:
        dest.mkdir(exist_ok=True)
        shutil.move(str(f), dest / f.name)
        print(f"archived v1 result {f.name}")
PY
}

for model in "${MODELS[@]}"; do
  slug="${model//:/-}"
  archive "${slug}__rag-off__safety-off__guide-on"
  run --model="$model" --rag=off --safety=off --guide=on
  archive "${slug}__rag-off__safety-on__guide-on"
  run --model="$model" --rag=off --safety=on --guide=on
  archive "${slug}__rag-on__safety-off"
  run --model="$model" --rag=on --safety=off --retrieval-cache="$CACHE"
  archive "${slug}__rag-on__safety-on"
  run --model="$model" --rag=on --safety=on --retrieval-cache="$CACHE"
done

python3 -I ../../research/analyze.py
