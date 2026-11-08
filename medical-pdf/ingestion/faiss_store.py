"""Local FAISS store with searchable metadata sidecar.

Vectors are L2-normalized and stored in an IndexFlatIP, so inner product ==
cosine similarity (matching Pinecone's cosine metric). Metadata lives in a
JSONL sidecar keyed by FAISS row id and supports post-filtering on any
field (content_type, disease_category, source_document, ...).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import faiss
import numpy as np

from chunker import DocumentChunk

log = logging.getLogger(__name__)

INDEX_FILE = "guidelines.faiss"
METADATA_FILE = "guidelines.metadata.jsonl"


class FaissStore:
    def __init__(self, dimension: int):
        self.dimension = dimension
        self.index = faiss.IndexFlatIP(dimension)
        self.records: list[dict] = []

    def add(self, chunks: list[DocumentChunk]) -> None:
        embedded = [c for c in chunks if c.embedding is not None]
        if not embedded:
            return
        matrix = np.asarray([c.embedding for c in embedded], dtype="float32")
        faiss.normalize_L2(matrix)
        self.index.add(matrix)
        for c in embedded:
            self.records.append({"id": c.id, "content": c.content, **c.metadata()})

    def search(self, query_embedding: list[float], k: int = 5, filters: dict | None = None) -> list[dict]:
        """Top-k by cosine similarity with optional exact-match metadata filters."""
        q = np.asarray([query_embedding], dtype="float32")
        faiss.normalize_L2(q)
        # Over-fetch when filtering, then post-filter.
        fetch = k * 10 if filters else k
        scores, ids = self.index.search(q, min(fetch, self.index.ntotal))
        results = []
        for score, row in zip(scores[0], ids[0]):
            if row < 0:
                continue
            rec = self.records[row]
            if filters and any(rec.get(f) != v for f, v in filters.items()):
                continue
            results.append({**rec, "score": float(score)})
            if len(results) >= k:
                break
        return results

    def save(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        faiss.write_index(self.index, str(out_dir / INDEX_FILE))
        with open(out_dir / METADATA_FILE, "w") as f:
            for rec in self.records:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        log.info("Saved FAISS index (%d vectors) to %s", self.index.ntotal, out_dir)

    @classmethod
    def load(cls, out_dir: Path) -> "FaissStore":
        index = faiss.read_index(str(out_dir / INDEX_FILE))
        store = cls(index.d)
        store.index = index
        with open(out_dir / METADATA_FILE) as f:
            store.records = [json.loads(line) for line in f if line.strip()]
        return store
