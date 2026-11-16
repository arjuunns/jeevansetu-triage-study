"""Fully local ingestion: PDF -> passages, with no cloud calls (added 9 Nov 2026).

Same parsing and 500/75-token chunking as main.py, but tables are converted with
the deterministic row-by-row converter, flowchart pages are not sent to an LLM
(their text is chunked like any other page), and no embeddings are computed
(the retrieval cache builder embeds locally with bge-m3). The output is
deterministic, so anyone with the same PDF gets the same chunk IDs.

    .venv/bin/python local_ingest.py --pdf ../Emergency_Severity_Index_v4_Handbook_2012.pdf \
        --keep ../9789241513081-eng.pdf=index/guidelines.metadata.jsonl --out index_v4/guidelines.metadata.jsonl

--keep copies the existing passages of a document from another metadata file unchanged
(e.g. the WHO and ICRC manual, so its chunk IDs stay the same as in the original runs).
Sections titled "References" are dropped: they carry no triage guidance.
"""

import argparse
import json
from pathlib import Path

from chunker import TextSegment, chunk_text_segments, make_atomic_chunk
from pdf_parser import parse_pdf
from table_converter import _fallback_conversion

DROP_SECTIONS = {"references"}


def ingest(pdf: Path) -> list[dict]:
    parsed = parse_pdf(pdf)
    chunks = []
    for page in parsed.pages:
        for table in page.tables:
            text = _fallback_conversion(table)
            if text:
                chunks.append(make_atomic_chunk(text, source_document=parsed.source_document,
                                                page_number=page.page_number, section_title=page.section_title,
                                                content_type="table"))
    segments = [TextSegment(text=p.text, page_number=p.page_number, section_title=p.section_title)
                for p in parsed.pages if p.text.strip()]
    chunks.extend(chunk_text_segments(segments, parsed.source_document))
    unique = {c.id: c for c in chunks}
    return [{"id": c.id, "content": c.content, **c.metadata()} for c in unique.values()
            if (c.metadata().get("section_title") or "").strip().lower() not in DROP_SECTIONS]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", type=Path, action="append", required=True)
    ap.add_argument("--keep", action="append", default=[], help="source_document_file=metadata.jsonl")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    records = []
    for spec in args.keep:
        doc, meta = spec.split("=", 1)
        name = Path(doc).name
        kept = [r for r in map(json.loads, open(meta)) if r["source_document"] == name]
        print(f"kept {len(kept)} passages of {name} from {meta}")
        records += kept
    for pdf in args.pdf:
        new = ingest(pdf)
        print(f"{pdf.name}: {len(new)} passages")
        records += new
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {len(records)} passages to {args.out}")


if __name__ == "__main__":
    main()
