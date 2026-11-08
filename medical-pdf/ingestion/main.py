"""Medical guideline ingestion pipeline for the JeevanSetu triage RAG.

PDF -> (cleaned text, NL tables, decision trees) -> 500-token chunks
    -> Gemini embeddings -> FAISS (local) + Pinecone (server index).

Usage:
    python main.py                       # ingest all PDFs in ../
    python main.py --pdf path/to/x.pdf   # single document
    python main.py --no-pinecone         # local FAISS only
    python main.py --query "chest pain"  # sanity-check search after ingest
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from google import genai

import flowchart_converter
import table_converter
from chunker import DocumentChunk, TextSegment, chunk_text_segments, make_atomic_chunk
from embedder import embed_chunks, embed_query
from faiss_store import FaissStore
from flowchart_converter import convert_flowchart_page
from pdf_parser import parse_pdf
from pinecone_store import push_chunks
from table_converter import convert_table

log = logging.getLogger("ingestion")

# Matches the existing 'jeevansetu-guidelines' Pinecone index (cosine, 1024).
# Embeddings come from gemini-embedding-001 truncated to this dimension.
# NOTE for the server: text-embedding-004 is retired (404); the query side in
# apps/server/src/lib/ai.ts must move to gemini-embedding-001 @ 1024 dims too.
EMBEDDING_DIM = 1024
EMBED_MODEL = "gemini-embedding-001"
RETIRED_EMBED_MODELS = {"text-embedding-004", "embedding-001"}

# Free-tier quotas (June 2026): 2.5-flash 10 RPM / 250 RPD, lite 15 RPM / 1000 RPD.
TABLE_MODEL = "gemini-2.5-flash-lite"
FLOWCHART_MODEL = "gemini-2.5-flash"
ZERO_QUOTA_MODELS = {"gemini-2.0-flash", "gemini-2.0-flash-lite"}
TABLE_CALL_INTERVAL_S = 4.0  # stay under 15 RPM
FLOWCHART_CALL_INTERVAL_S = 6.0  # stay under 10 RPM

# Map known files to the server's GUIDELINE_SOURCES enum.
SOURCE_MAP = {
    "emergency_severity_index": ("ESI", "Emergency Severity Index Handbook"),
    "9789241513081": ("WHO", "WHO Emergency Care Guidelines (9789241513081)"),
    "abbreviations": ("OTHER", "Medical Abbreviations List"),
}


def resolve_source(pdf: Path) -> tuple[str, str]:
    stem = pdf.stem.lower()
    for key, value in SOURCE_MAP.items():
        if key in stem:
            return value
    return "OTHER", pdf.stem.replace("_", " ").replace("-", " ").title()


def ingest_document(
    pdf: Path,
    client: genai.Client,
    *,
    table_model: str,
    flowchart_model: str,
    skip_flowcharts: bool,
    stats: dict,
) -> list[DocumentChunk]:
    parsed = parse_pdf(pdf)
    stats["pages_processed"] += parsed.page_count
    chunks: list[DocumentChunk] = []

    # --- tables -> natural language, atomic chunks ---
    for page in parsed.pages:
        for table in page.tables:
            if not table_converter.quota_exhausted():
                time.sleep(TABLE_CALL_INTERVAL_S)  # free-tier RPM pacing
            text = convert_table(client, table_model, table, parsed.source_document, page.section_title)
            if not text:
                continue
            chunks.append(
                make_atomic_chunk(
                    text,
                    source_document=parsed.source_document,
                    page_number=page.page_number,
                    section_title=page.section_title,
                    content_type="table",
                )
            )
            stats["tables_converted"] += 1

    # --- flowchart pages -> decision trees, atomic chunks ---
    if not skip_flowcharts:
        candidates = [p for p in parsed.pages if p.is_flowchart_candidate]
        log.info("%s: sending %d flowchart-candidate pages to %s", pdf.name, len(candidates), flowchart_model)
        for page in candidates:
            if flowchart_converter.quota_exhausted():
                stats["flowchart_pages_skipped"].append(
                    {"document": parsed.source_document, "page": page.page_number}
                )
                continue
            time.sleep(FLOWCHART_CALL_INTERVAL_S)  # free-tier RPM pacing
            tree = convert_flowchart_page(client, flowchart_model, pdf, page.page_number)
            if not tree:
                if flowchart_converter.quota_exhausted():
                    stats["flowchart_pages_skipped"].append(
                        {"document": parsed.source_document, "page": page.page_number}
                    )
                continue
            chunks.append(
                make_atomic_chunk(
                    tree,
                    source_document=parsed.source_document,
                    page_number=page.page_number,
                    section_title=page.section_title,
                    content_type="decision_tree",
                )
            )
            stats["flowcharts_converted"] += 1

    # --- paragraph text -> 500/75 token sliding window ---
    segments = [
        TextSegment(text=p.text, page_number=p.page_number, section_title=p.section_title)
        for p in parsed.pages
        if p.text.strip()
    ]
    chunks.extend(chunk_text_segments(segments, parsed.source_document))

    # Deduplicate by id (overlapping windows can collide on identical text).
    unique = {c.id: c for c in chunks}
    chunks = list(unique.values())
    stats["chunks_created"] += len(chunks)
    log.info("%s: %d chunks", pdf.name, len(chunks))
    return chunks


def main() -> int:
    parser = argparse.ArgumentParser(description="Medical PDF ingestion for JeevanSetu RAG")
    parser.add_argument("--pdf", type=Path, action="append", help="specific PDF(s); default: all in --pdf-dir")
    parser.add_argument("--pdf-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent / "index")
    parser.add_argument("--no-pinecone", action="store_true", help="skip Pinecone upsert (FAISS only)")
    parser.add_argument("--skip-flowcharts", action="store_true", help="skip multimodal flowchart conversion")
    parser.add_argument(
        "--wipe-index", action="store_true",
        help="delete ALL vectors from the Pinecone index before ingesting (clean re-run)",
    )
    parser.add_argument("--query", help="run a sanity-check FAISS search after ingestion")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    # .env lives at the repo root (capstone/.env).
    repo_root = Path(__file__).resolve().parents[2]
    load_dotenv(repo_root / ".env")

    gemini_key = os.environ.get("GEMINI_API_KEY")
    if not gemini_key:
        log.error("GEMINI_API_KEY missing from %s", repo_root / ".env")
        return 1
    embed_model = os.environ.get("GEMINI_EMBEDDING_MODEL", EMBED_MODEL)
    if embed_model in RETIRED_EMBED_MODELS:
        log.warning("Embedding model %s is retired — using %s", embed_model, EMBED_MODEL)
        embed_model = EMBED_MODEL
    table_model = os.environ.get("GEMINI_TRIAGE_MODEL", TABLE_MODEL)
    if table_model in ZERO_QUOTA_MODELS:
        log.warning("Model %s has no free-tier quota — tables via %s, flowcharts via %s",
                    table_model, TABLE_MODEL, FLOWCHART_MODEL)
        table_model = TABLE_MODEL
    flowchart_model = FLOWCHART_MODEL
    pinecone_key = os.environ.get("PINECONE_API_KEY")
    pinecone_index = os.environ.get("PINECONE_INDEX", "jeevansetu-guidelines")

    # ESI handbook first: if the daily vision quota runs out mid-run, the core
    # triage-algorithm flowcharts are the ones that must make it in.
    pdfs = args.pdf or sorted(
        args.pdf_dir.glob("*.pdf"),
        key=lambda p: (0 if "severity_index" in p.stem.lower() else 1, p.name),
    )
    if not pdfs:
        log.error("No PDFs found in %s", args.pdf_dir)
        return 1

    client = genai.Client(api_key=gemini_key)
    store = FaissStore(EMBEDDING_DIM)
    stats = {
        "pages_processed": 0,
        "tables_converted": 0,
        "flowcharts_converted": 0,
        "chunks_created": 0,
        "embeddings_generated": 0,
        "vectors_pushed_to_pinecone": 0,
        "flowchart_pages_skipped": [],
    }

    if args.wipe_index and not args.no_pinecone and pinecone_key:
        from pinecone import Pinecone

        log.warning("Wiping all vectors from Pinecone index '%s'", pinecone_index)
        Pinecone(api_key=pinecone_key).Index(pinecone_index).delete(delete_all=True)

    for pdf in pdfs:
        log.info("=== Ingesting %s ===", pdf.name)
        chunks = ingest_document(
            pdf, client,
            table_model=table_model, flowchart_model=flowchart_model,
            skip_flowcharts=args.skip_flowcharts, stats=stats,
        )
        stats["embeddings_generated"] += embed_chunks(client, embed_model, chunks, EMBEDDING_DIM)
        store.add(chunks)
        if not args.no_pinecone:
            if not pinecone_key:
                log.warning("PINECONE_API_KEY missing — skipping Pinecone upsert")
            else:
                source, title = resolve_source(pdf)
                stats["vectors_pushed_to_pinecone"] += push_chunks(
                    pinecone_key, pinecone_index, chunks, source=source, title=title
                )

    store.save(args.out_dir)

    skipped = stats.pop("flowchart_pages_skipped")
    if skipped:
        import json

        skip_file = args.out_dir / "skipped_flowchart_pages.json"
        skip_file.write_text(json.dumps(skipped, indent=2))
        log.warning(
            "%d flowchart pages skipped (daily Gemini quota) — recorded in %s; "
            "re-run after quota reset with --pdf <doc> to convert them",
            len(skipped), skip_file,
        )

    log.info("================ INGESTION SUMMARY ================")
    for key, value in stats.items():
        log.info("%-28s %d", key.replace("_", " "), value)
    log.info("flowchart pages skipped      %d", len(skipped))
    log.info("===================================================")

    if args.query:
        log.info("Sanity-check search: %r", args.query)
        qvec = embed_query(client, embed_model, args.query, EMBEDDING_DIM)
        for hit in store.search(qvec, k=5):
            log.info(
                "  %.3f [%s p%s %s] %s",
                hit["score"], hit["source_document"], hit["page_number"],
                hit["content_type"], hit["content"][:120].replace("\n", " "),
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
