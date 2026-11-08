"""Chunking for retrieval.

- Paragraph text: 500-token chunks with 75-token overlap, split on sentence
  boundaries, accumulated across pages within a section so related clinical
  logic stays together.
- Tables and decision trees: always atomic — never split, even if they
  exceed the target size.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

import tiktoken

CHUNK_TOKENS = 500
OVERLAP_TOKENS = 75
MIN_CHUNK_TOKENS = 25  # drop fragments too small to be useful for retrieval

_ENC = tiktoken.get_encoding("cl100k_base")

SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")

DISEASE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "cardiac": ("cardiac", "chest pain", "myocardial", "ecg", "ekg", "arrhythmia", "heart"),
    "respiratory": ("respiratory", "spo2", "oxygen", "asthma", "copd", "pneumonia", "airway", "breath"),
    "neurological": ("stroke", "seizure", "neurolog", "consciousness", "gcs", "headache"),
    "trauma": ("trauma", "fracture", "injury", "wound", "burn", "bleeding", "hemorrhage"),
    "infectious_disease": ("infection", "sepsis", "fever", "tuberculosis", "malaria", "hiv", "antibiotic"),
    "pediatric": ("pediatric", "paediatric", "child", "infant", "neonat"),
    "obstetric": ("pregnan", "obstetric", "labor", "labour", "delivery", "maternal"),
    "gastrointestinal": ("abdominal", "vomit", "diarrh", "gastro", "liver"),
    "mental_health": ("psychiatric", "suicid", "mental health", "behavioral health"),
    "toxicology": ("poison", "overdose", "toxic", "ingestion"),
    "triage_process": ("triage", "esi level", "acuity", "resource"),
}


@dataclass
class DocumentChunk:
    id: str
    content: str
    source_document: str
    page_number: int
    section_title: str
    content_type: str  # paragraph | table | decision_tree
    disease_category: str
    embedding: list[float] | None = field(default=None, repr=False)

    def metadata(self) -> dict:
        return {
            "source_document": self.source_document,
            "page_number": self.page_number,
            "section_title": self.section_title,
            "content_type": self.content_type,
            "disease_category": self.disease_category,
        }


def count_tokens(text: str) -> int:
    return len(_ENC.encode(text))


def classify_disease_category(*texts: str) -> str:
    """Keyword-based category (deterministic, no API cost). Section title is
    weighted by being checked first."""
    haystack = " ".join(t.lower() for t in texts if t)
    best, best_hits = "general", 0
    for category, keywords in DISEASE_CATEGORIES.items():
        hits = sum(haystack.count(k) for k in keywords)
        if hits > best_hits:
            best, best_hits = category, hits
    return best


def _chunk_id(source_document: str, content: str) -> str:
    """Deterministic id so re-running ingestion upserts instead of duplicating."""
    digest = hashlib.sha1(f"{source_document}::{content}".encode()).hexdigest()
    return f"chunk-{digest[:20]}"


def make_atomic_chunk(
    content: str,
    *,
    source_document: str,
    page_number: int,
    section_title: str,
    content_type: str,
) -> DocumentChunk:
    """One indivisible chunk for a table or decision tree."""
    return DocumentChunk(
        id=_chunk_id(source_document, content),
        content=content.strip(),
        source_document=source_document,
        page_number=page_number,
        section_title=section_title,
        content_type=content_type,
        disease_category=classify_disease_category(section_title, content),
    )


@dataclass
class TextSegment:
    """A run of paragraph text tagged with its page and section."""

    text: str
    page_number: int
    section_title: str


def chunk_text_segments(segments: list[TextSegment], source_document: str) -> list[DocumentChunk]:
    """Sliding-window chunking over a section's text stream.

    Segments are grouped by section_title (consecutive), sentences are packed
    to CHUNK_TOKENS with OVERLAP_TOKENS carried between chunks. A chunk's
    page_number is the page where it starts.
    """
    chunks: list[DocumentChunk] = []

    # Group consecutive segments by section so windows never straddle sections.
    groups: list[list[TextSegment]] = []
    for seg in segments:
        if not seg.text.strip():
            continue
        if groups and groups[-1][0].section_title == seg.section_title:
            groups[-1].append(seg)
        else:
            groups.append([seg])

    for group in groups:
        section = group[0].section_title
        # (sentence, page) stream for the whole group.
        stream: list[tuple[str, int]] = []
        for seg in group:
            for para in seg.text.split("\n"):
                para = para.strip()
                if not para:
                    continue
                for sent in SENTENCE_SPLIT_RE.split(para):
                    if sent.strip():
                        stream.append((sent.strip(), seg.page_number))

        window: list[tuple[str, int]] = []
        window_tokens = 0
        for sent, page in stream:
            sent_tokens = count_tokens(sent)
            if window and window_tokens + sent_tokens > CHUNK_TOKENS:
                chunks.append(_emit(window, source_document, section))
                # Carry overlap: keep trailing sentences up to OVERLAP_TOKENS.
                kept: list[tuple[str, int]] = []
                kept_tokens = 0
                for s, p in reversed(window):
                    t = count_tokens(s)
                    if kept_tokens + t > OVERLAP_TOKENS:
                        break
                    kept.insert(0, (s, p))
                    kept_tokens += t
                window, window_tokens = kept, kept_tokens
            window.append((sent, page))
            window_tokens += sent_tokens
        if window and window_tokens >= MIN_CHUNK_TOKENS:
            chunks.append(_emit(window, source_document, section))

    return chunks


def _emit(window: list[tuple[str, int]], source_document: str, section: str) -> DocumentChunk:
    content = " ".join(s for s, _ in window).strip()
    page = window[0][1]
    return DocumentChunk(
        id=_chunk_id(source_document, content),
        content=content,
        source_document=source_document,
        page_number=page,
        section_title=section,
        content_type="paragraph",
        disease_category=classify_disease_category(section, content),
    )
