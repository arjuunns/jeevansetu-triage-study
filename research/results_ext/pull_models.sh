#!/usr/bin/env bash
# Pulls the models for the extension experiments into the Ollama server on port 11535 (rule 3).
# Usage: bash research/results_ext/pull_models.sh model [model ...]
set -uo pipefail
URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11535}"
for m in "$@"; do
  echo "[$(date '+%F %T')] free: $(df -h /workspace | awk 'NR==2{print $4}')  pulling $m"
  for attempt in 1 2 3; do
    curl -fsS -N -X POST "$URL/api/pull" -d "{\"model\": \"$m\"}" | python3 -u -c '
import json, sys, time
last = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if "error" in d:
        print("  error:", d["error"], flush=True); sys.exit(1)
    if d.get("total") and d.get("completed"):
        if time.time() - last > 30:
            print("  %s %.0f%% of %.1f GB" % (d.get("status", "")[:30], 100.0 * d["completed"] / d["total"], d["total"] / 1e9), flush=True); last = time.time()
    elif d.get("status") == "success":
        print("  success", flush=True)
' && break
    echo "  attempt $attempt failed; retrying in 20 s"; sleep 20
  done
done
echo "[$(date '+%F %T')] done. free: $(df -h /workspace | awk 'NR==2{print $4}')"
