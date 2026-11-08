"""Embeddings via Gemini gemini-embedding-001.

text-embedding-004 (the model in the server's env) has been RETIRED by
Google (404 as of June 2026). gemini-embedding-001 uses Matryoshka
representations, so output_dimensionality is set to match the existing
Pinecone index (1024-dim) and vectors are re-normalized after truncation,
as Google recommends for non-3072 dimensions.

The JeevanSetu server must embed queries with the SAME model and dimension
or Pinecone similarity is meaningless — see the migration note in main.py.
"""

from __future__ import annotations

import logging
import math
import time

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from chunker import DocumentChunk

log = logging.getLogger(__name__)

# Small batches + pacing keep free-tier limits happy (~30k tokens/minute):
# 20 chunks x ~400 tokens with a pause stays under the per-minute window.
EMBED_BATCH_SIZE = 20
INTER_BATCH_SLEEP_S = 15.0
_MAX_RETRIES = 6


def _normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm else vec


def embed_chunks(
    client: genai.Client, model: str, chunks: list[DocumentChunk], dimension: int
) -> int:
    """Embed chunks in place. Returns the number of embeddings generated."""
    total = 0
    for start in range(0, len(chunks), EMBED_BATCH_SIZE):
        if start:
            time.sleep(INTER_BATCH_SLEEP_S)
        batch = chunks[start : start + EMBED_BATCH_SIZE]
        vectors = _embed_batch(client, model, [c.content for c in batch], dimension)
        for chunk, vec in zip(batch, vectors):
            chunk.embedding = vec
        total += len(vectors)
        log.info("Embedded %d/%d chunks", min(start + EMBED_BATCH_SIZE, len(chunks)), len(chunks))
    return total


def _embed_batch(
    client: genai.Client, model: str, texts: list[str], dimension: int
) -> list[list[float]]:
    for attempt in range(_MAX_RETRIES):
        try:
            resp = client.models.embed_content(
                model=model,
                contents=texts,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_DOCUMENT", output_dimensionality=dimension
                ),
            )
            return [_normalize(e.values) for e in resp.embeddings]
        except genai_errors.APIError as e:
            if e.code in (429, 500, 503) and attempt < _MAX_RETRIES - 1:
                # Per-minute windows need a long wait, not a quick backoff.
                wait = 65 if e.code == 429 else 2 ** (attempt + 1)
                log.warning("Embedding API %s, retrying in %ss", e.code, wait)
                time.sleep(wait)
                continue
            raise
    raise RuntimeError("unreachable")


def embed_query(client: genai.Client, model: str, text: str, dimension: int) -> list[float]:
    """Query-side embedding, used by the FAISS sanity-check search."""
    resp = client.models.embed_content(
        model=model,
        contents=[text],
        config=types.EmbedContentConfig(
            task_type="RETRIEVAL_QUERY", output_dimensionality=dimension
        ),
    )
    return _normalize(resp.embeddings[0].values)
