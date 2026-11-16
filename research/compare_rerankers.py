"""Compare the passages chosen by two retrieval caches (e.g. Gemini vs local reranker).

    python3 -I research/compare_rerankers.py [A.json] [B.json]

Defaults: research/retrieval_cache.json (Gemini) vs research/retrieval_cache.local.json (local
cross-encoder). Reports, per patient, how many of the top-5 passages are shared, whether the
same top passage was chosen, the overall source mix of each cache and how often the curated
ESI guide appears. Prints only chunk IDs and source names, never passage text.
"""

import json
import statistics
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
a_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "retrieval_cache.json"
b_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "retrieval_cache.local.json"
A, B = (json.loads(p.read_text())["entries"] for p in (a_path, b_path))
ids = sorted(set(A) & set(B))
if not ids:
    sys.exit("no patients in common")


def top(e):
    return [c["chunkId"] for c in e["citations"]]


def sources(entries):
    return Counter(c["guidelineId"] for i in ids for c in entries[i]["citations"])


same_candidates = sum(
    [c["chunkId"] for c in A[i]["candidates"]] == [c["chunkId"] for c in B[i]["candidates"]] for i in ids
)
overlap = [len(set(top(A[i])) & set(top(B[i]))) for i in ids]
first = sum(top(A[i])[0] == top(B[i])[0] for i in ids)
dist = Counter(overlap)

print(f"A: {a_path.name}  ({A[ids[0]].get('reranker')})")
print(f"B: {b_path.name}  ({B[ids[0]].get('reranker')})")
print(f"patients compared: {len(ids)}; identical 20-candidate pools: {same_candidates}")
print(f"shared passages in top 5: mean {statistics.mean(overlap):.2f}, median {statistics.median(overlap)}")
print("  distribution:", {k: dist[k] for k in range(6)})
print(f"same first passage: {first}/{len(ids)} ({first / len(ids):.1%})")
for name, entries in (("A", A), ("B", B)):
    s = sources(entries)
    tot = sum(s.values())
    print(f"sources {name}: " + ", ".join(f"{k} {v / tot:.1%}" for k, v in s.most_common()))
