"""Public versions of the retrieval caches, without the ESI handbook text.

The caches hold the passages every model saw. Pipeline v2 (the paper's results) retrieves from the ESI v4
implementation handbook, 2012 edition (AHRQ Publication No. 12-0014); pipeline v1 retrieved from the ESI Handbook,
5th edition ((c) ENA 2023). The ESI algorithm is the property of the ESI Triage Research Team, so neither handbook's
text is redistributed: the public copies keep only the chunk IDs of handbook passages. A chunk ID is a hash of the
source file name and the chunk text (medical-pdf/ingestion/chunker.py), so readers who rebuild the passages from their
own copy of the handbook get the same IDs, and `restore` puts the text back exactly. Passages from the WHO and ICRC
manual (CC BY-NC-SA 3.0 IGO) and from our own ESI guide are kept.

    python3 -I research/public_cache.py strip     # writes research/retrieval_cache*.public.json
    python3 -I research/public_cache.py restore   # v2: needs medical-pdf/ingestion/index_v4/guidelines.metadata.jsonl
                                                  # v1: needs medical-pdf/ingestion/index/guidelines.metadata.jsonl
                                                  #     (LLM-converted table chunks may not come back; reported)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX_V1 = ROOT / "medical-pdf" / "ingestion" / "index" / "guidelines.metadata.jsonl"
INDEX_V4 = ROOT / "medical-pdf" / "ingestion" / "index_v4" / "guidelines.metadata.jsonl"
# cache file -> passage index its handbook text comes from
CACHES = {
    "retrieval_cache.v2.json": INDEX_V4, "retrieval_cache_baseline.v2.json": INDEX_V4,
    "retrieval_cache.json": INDEX_V1, "retrieval_cache_baseline.json": INDEX_V1,
}
WITHHELD = {"Emergency_Severity_Index_Handbook.pdf", "Emergency_Severity_Index_v4_Handbook_2012.pdf"}


def public_path(name):
    return ROOT / "research" / name.replace(".json", ".public.json")


def js_number(x):
    """A number as JavaScript's JSON.stringify prints it (the caches were written by Node.js)."""
    if isinstance(x, int):
        return str(x)
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)
    if "e" not in r:
        return r
    mantissa, exp = r.split("e")
    exp = int(exp)
    if -7 < exp < 0:  # JavaScript switches to exponent notation only below 1e-6
        return ("-" if x < 0 else "") + "0." + "0" * (-exp - 1) + mantissa.replace(".", "").lstrip("-")
    return f"{mantissa}e{'+' if exp > 0 else '-'}{abs(exp)}"


def dumps_js(obj, depth=0):
    """json.dumps(obj, indent=2) with JavaScript number formatting, so a restored cache is byte-identical
    to the original and passes the hash check of research/run_gpu.sh."""
    pad, end = "  " * (depth + 1), "  " * depth
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        return "{\n" + ",\n".join(f"{pad}{json.dumps(k, ensure_ascii=False)}: {dumps_js(v, depth + 1)}"
                                  for k, v in obj.items()) + f"\n{end}}}"
    if isinstance(obj, list):
        if not obj:
            return "[]"
        return "[\n" + ",\n".join(pad + dumps_js(v, depth + 1) for v in obj) + f"\n{end}]"
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        return js_number(obj)
    return json.dumps(obj, ensure_ascii=False)


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
    restored = 0
    for name, index in CACHES.items():
        if not public_path(name).exists():
            continue
        if not index.exists():
            print(f"skipped research/{name}: {index.relative_to(ROOT)} not found (see README)")
            continue
        content = {}
        for line in index.read_text().splitlines():
            chunk = json.loads(line)
            content[chunk["id"]] = chunk["content"]
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
        (ROOT / "research" / name).write_text(dumps_js(cache) + "\n")
        restored += 1
        print(f"restored research/{name}")
        if missing:
            # Paragraph chunks are plain extracted text and come back exactly. Table chunks were turned into
            # sentences by an LLM during ingestion, so a rebuilt index usually has different text and IDs for them.
            print(f"  {len(missing)} distinct passages not in your index (usually the LLM-converted table chunks); "
                  "they are marked in the file, so RAG runs that used them will not be identical.")
    if not restored:
        raise SystemExit("nothing restored: rebuild the passage index first (see README)")


if __name__ == "__main__":
    {"strip": strip, "restore": restore}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
