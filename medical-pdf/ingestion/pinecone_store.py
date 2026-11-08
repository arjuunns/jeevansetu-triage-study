"""Push chunks to the JeevanSetu Pinecone index.

Metadata layout is compatible with the server's retrieval code
(apps/server/src/modules/rag/rag.service.ts), which reads guidelineId,
chunkId, source, title and content from vector metadata — plus the
ingestion-spec fields (source_document, page_number, section_title,
content_type, disease_category) for filtered retrieval.
"""

from __future__ import annotations

import logging
import re

from pinecone import Pinecone

from chunker import DocumentChunk

log = logging.getLogger(__name__)

UPSERT_BATCH_SIZE = 100
CONTENT_METADATA_LIMIT = 2000  # mirrors server-side slice; keeps metadata < 40 KB


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def push_chunks(
    api_key: str,
    index_name: str,
    chunks: list[DocumentChunk],
    *,
    source: str,
    title: str,
) -> int:
    """Upsert embedded chunks. Returns the number of vectors pushed."""
    embedded = [c for c in chunks if c.embedding is not None]
    if not embedded:
        return 0

    pc = Pinecone(api_key=api_key)
    desc = pc.describe_index(index_name)
    dim = len(embedded[0].embedding)
    if desc.dimension != dim:
        raise ValueError(
            f"Pinecone index '{index_name}' has dimension {desc.dimension}, "
            f"but embeddings are {dim}-dimensional. Refusing to upsert."
        )
    index = pc.Index(index_name)

    guideline_id = f"ingest-{_slug(title)}"
    pushed = 0
    for start in range(0, len(embedded), UPSERT_BATCH_SIZE):
        batch = embedded[start : start + UPSERT_BATCH_SIZE]
        vectors = [
            {
                "id": c.id,
                "values": c.embedding,
                "metadata": {
                    # Fields the server's retrieveGuidelines() expects:
                    "guidelineId": guideline_id,
                    "chunkId": c.id,
                    "chunkIndex": start + i,
                    "source": source,
                    "title": title,
                    "content": c.content[:CONTENT_METADATA_LIMIT],
                    # Ingestion-spec fields for filtered retrieval:
                    "source_document": c.source_document,
                    "page_number": c.page_number,
                    "section_title": c.section_title or "unknown",
                    "content_type": c.content_type,
                    "disease_category": c.disease_category,
                },
            }
            for i, c in enumerate(batch)
        ]
        index.upsert(vectors=vectors)
        pushed += len(vectors)
        log.info("Upserted %d/%d vectors to '%s'", pushed, len(embedded), index_name)
    return pushed
