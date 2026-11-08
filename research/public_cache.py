"""Public versions of the retrieval caches, without the copyrighted ESI handbook text.

The caches (research/retrieval_cache.json, research/retrieval_cache_baseline.json) hold the passages every
model saw. Passages from the ESI Handbook (5th edition, (c) ENA 2023) may not be redistributed, so the public
copies keep only their chunk IDs. A chunk ID is a hash of the source file name and the chunk text
(medical-pdf/ingestion/chunker.py), so readers who rebuild the index from their own copy of the handbook get
the same IDs, and `restore` puts the paragraph text back exactly. Passages from the WHO and ICRC manual (CC BY-NC-SA 3.0
IGO) and from our own ESI guide are kept.

    python3 -I research/public_cache.py strip     # writes research/retrieval_cache*.public.json
    python3 -I research/public_cache.py restore   # needs medical-pdf/ingestion/index/guidelines.metadata.jsonl;
                                                  # LLM-converted table chunks may not come back (reported)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHES = ["retrieval_cache.json", "retrieval_cache_baseline.json"]
INDEX = ROOT / "medical-pdf" / "ingestion" / "index" / "guidelines.metadata.jsonl"
WITHHELD = {"Emergency_Severity_Index_Handbook.pdf"}


def public_path(name):
    return ROOT / "research" / name.replace(".json", ".public.json")


def strip():
    for name in CACHES:
        cache = json.loads((ROOT / "research" / name).read_text())
        removed = 0
        for entry in cache["entries"].values():
            for c in entry["citations"]:
                if c["guidelineId"] in WITHHELD:
                    c["snippetChars"] = len(c["snippet"])
                    c["snippet"] = None
                    removed += 1
        cache["meta"]["withheldText"] = sorted(WITHHELD)
        public_path(name).write_text(json.dumps(cache, ensure_ascii=False, indent=1))
        print(f"{public_path(name).name}: text removed from {removed} passages")


def restore():
    if not INDEX.exists():
        raise SystemExit(f"{INDEX.relative_to(ROOT)} not found: rebuild the index first (see README)")
    content = {}
    for line in INDEX.read_text().splitlines():
        chunk = json.loads(line)
        content[chunk["id"]] = chunk["content"]
    for name in CACHES:
        cache = json.loads(public_path(name).read_text())
        missing = set()
        for entry in cache["entries"].values():
            for c in entry["citations"]:
                if c["snippet"] is not None:
                    continue
                n = c.pop("snippetChars")
                text = content.get(c["chunkId"])
                if text is None:
                    missing.add(c["chunkId"])
                    text = f"[passage not restored: {c['chunkId']}]"
                c["snippet"] = text[:n]
        del cache["meta"]["withheldText"]
        (ROOT / "research" / name).write_text(json.dumps(cache, ensure_ascii=False, indent=2))
        print(f"restored research/{name}")
        if missing:
            # Paragraph chunks are plain extracted text and come back exactly. Table chunks were turned into
            # sentences by an LLM during ingestion, so a rebuilt index usually has different text and IDs for them.
            print(f"  {len(missing)} distinct passages not in your index (usually the LLM-converted table chunks); "
                  "they are marked in the file, so RAG runs that used them will not be identical.")


if __name__ == "__main__":
    {"strip": strip, "restore": restore}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
