"""PDF parsing with PyMuPDF.

Extracts page-by-page content, strips repeated headers/footers and page
numbers, repairs broken line wrapping, detects tables and flags pages that
look like flowcharts/decision diagrams so they can be routed to the
multimodal converter.
"""

from __future__ import annotations

import logging
import re
import statistics
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import fitz  # PyMuPDF

log = logging.getLogger(__name__)

# Pages whose vector-drawing count exceeds this are flowchart candidates.
FLOWCHART_DRAWING_THRESHOLD = 25
# Lower drawing threshold when flowchart keywords appear in the page text.
FLOWCHART_KEYWORD_DRAWING_THRESHOLD = 8
FLOWCHART_KEYWORDS = re.compile(
    r"\b(algorithm|flow\s?chart|decision\s+(tree|point|aid)|triage\s+(algorithm|pathway)|"
    r"pathway|see\s+figure|fig(ure)?\.?\s*\d)\b",
    re.IGNORECASE,
)

PAGE_NUMBER_RE = re.compile(r"^\s*(page\s+)?\d{1,4}(\s+of\s+\d{1,4})?\s*$", re.IGNORECASE)
HYPHEN_BREAK_RE = re.compile(r"(\w)-\n(\w)")


@dataclass
class RawTable:
    """A table as extracted by PyMuPDF: list of rows of cell strings."""

    page_number: int
    rows: list[list[str]]
    bbox: tuple[float, float, float, float]

    def to_markdown(self) -> str:
        rows = [[(c or "").strip().replace("\n", " ") for c in row] for row in self.rows]
        rows = [r for r in rows if any(r)]
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
        lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n".join(lines)


@dataclass
class PageContent:
    page_number: int  # 1-based
    text: str
    section_title: str
    tables: list[RawTable] = field(default_factory=list)
    is_flowchart_candidate: bool = False


@dataclass
class ParsedDocument:
    source_document: str
    path: Path
    pages: list[PageContent]

    @property
    def page_count(self) -> int:
        return len(self.pages)


def _line_fingerprint(line: str) -> str:
    """Normalize digits so 'Page 3' and 'Page 17' share a fingerprint."""
    return re.sub(r"\d+", "#", line.strip().lower())


def _collect_page_lines(page: fitz.Page, table_rects: list[fitz.Rect]) -> list[str]:
    """Text lines outside table regions, in reading order."""
    lines: list[str] = []
    for block in page.get_text("blocks", sort=True):
        rect = fitz.Rect(block[:4])
        if block[6] != 0:
            continue
        if any(
            not (rect & tr).is_empty and (rect & tr).get_area() > 0.5 * rect.get_area()
            for tr in table_rects
            if rect.get_area() > 0
        ):
            continue
        lines.extend(block[4].splitlines())
    return [ln.rstrip() for ln in lines]


def _detect_headings(page: fitz.Page, body_size: float) -> list[str]:
    """Short, larger-or-bold lines are treated as section headings."""
    headings: list[str] = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = "".join(s["text"] for s in spans).strip()
            if not text or len(text) > 90 or PAGE_NUMBER_RE.match(text):
                continue
            max_size = max(s["size"] for s in spans)
            bold = all(s.get("flags", 0) & 2**4 for s in spans)
            if max_size >= body_size * 1.2 or (bold and max_size >= body_size * 1.08):
                headings.append(re.sub(r"\s+", " ", text))
    return headings


def _join_wrapped_lines(lines: list[str]) -> str:
    """Repair hard line wraps: hyphen breaks and mid-sentence newlines."""
    text = "\n".join(lines)
    text = HYPHEN_BREAK_RE.sub(r"\1\2", text)
    out: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            out.append("")
            continue
        if (
            out
            and out[-1]
            and not out[-1].endswith((".", "!", "?", ":", ";", "•"))
            and (stripped[0].islower() or stripped[0].isdigit() or stripped[0] in "([")
        ):
            out[-1] = out[-1] + " " + stripped
        else:
            out.append(stripped)
    text = "\n".join(out)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_pdf(path: Path) -> ParsedDocument:
    doc = fitz.open(path)
    n_pages = len(doc)
    log.info("Parsing %s (%d pages)", path.name, n_pages)

    # ---- pass 1: gather raw lines, tables, drawing counts, font sizes ----
    page_lines: list[list[str]] = []
    page_tables: list[list[RawTable]] = []
    drawing_counts: list[int] = []
    span_sizes: list[float] = []
    edge_fingerprints: Counter[str] = Counter()

    for page in doc:
        tabs = page.find_tables()
        tables = []
        for t in tabs.tables:
            rows = t.extract()
            if rows and sum(1 for r in rows for c in r if c and str(c).strip()) >= 4:
                tables.append(RawTable(page.number + 1, rows, t.bbox))
        table_rects = [fitz.Rect(t.bbox) for t in tables]
        lines = _collect_page_lines(page, table_rects)
        page_lines.append(lines)
        page_tables.append(tables)
        # Count only drawings outside table regions — cell borders otherwise
        # make every table-heavy page look like a flowchart. Borders can
        # overhang the detected bbox by a fraction of a point, so test
        # intersection against slightly inflated rects.
        inflated = [fitz.Rect(tr.x0 - 3, tr.y0 - 3, tr.x1 + 3, tr.y1 + 3) for tr in table_rects]
        drawing_counts.append(
            sum(
                1
                for d in page.get_drawings()
                if not any(fitz.Rect(d["rect"]).intersects(tr) for tr in inflated)
            )
        )
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                span_sizes.extend(s["size"] for s in line.get("spans", []))
        # Header/footer candidates: first and last 2 non-empty lines per page.
        non_empty = [ln for ln in lines if ln.strip()]
        for edge in non_empty[:2] + non_empty[-2:]:
            edge_fingerprints[_line_fingerprint(edge)] += 1

    body_size = statistics.median(span_sizes) if span_sizes else 10.0
    min_repeats = max(3, int(n_pages * 0.3))
    repeated_edges = {fp for fp, c in edge_fingerprints.items() if c >= min_repeats and fp}

    # ---- pass 2: clean text, detect headings/flowcharts, carry sections ----
    pages: list[PageContent] = []
    current_section = ""
    for i, page in enumerate(doc):
        lines = [
            ln
            for ln in page_lines[i]
            if not PAGE_NUMBER_RE.match(ln) and _line_fingerprint(ln) not in repeated_edges
        ]
        text = _join_wrapped_lines(lines)
        headings = _detect_headings(page, body_size)
        if headings:
            current_section = headings[0]
        drawings = drawing_counts[i]
        has_keyword = bool(FLOWCHART_KEYWORDS.search(text))
        is_flowchart = drawings >= FLOWCHART_DRAWING_THRESHOLD or (
            has_keyword and drawings >= FLOWCHART_KEYWORD_DRAWING_THRESHOLD
        )
        pages.append(
            PageContent(
                page_number=i + 1,
                text=text,
                section_title=current_section,
                tables=page_tables[i],
                is_flowchart_candidate=is_flowchart,
            )
        )

    doc.close()
    n_tables = sum(len(p.tables) for p in pages)
    n_flow = sum(p.is_flowchart_candidate for p in pages)
    log.info(
        "%s: %d pages, %d tables, %d flowchart-candidate pages",
        path.name, n_pages, n_tables, n_flow,
    )
    return ParsedDocument(source_document=path.name, path=path, pages=pages)


def render_page_png(path: Path, page_number: int, zoom: float = 2.0) -> bytes:
    """Render a 1-based page to PNG bytes for the multimodal model."""
    with fitz.open(path) as doc:
        page = doc[page_number - 1]
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        return pix.tobytes("png")
