"""Convert extracted tables into natural-language statements.

Primary path uses Gemini so messy clinical tables (merged cells, units in
headers, footnotes) become clean prose. A deterministic row-by-row fallback
keeps the pipeline working if the API call fails.
"""

from __future__ import annotations

import logging
import time

from google import genai
from google.genai import errors as genai_errors

from pdf_parser import RawTable

log = logging.getLogger(__name__)

TABLE_PROMPT = """You are converting a table from a medical guideline into natural language \
for a clinical retrieval system.

Rewrite the table below as clear, standalone English sentences.

Requirements:
- Preserve EVERY row and every value. Do not summarize or omit rows.
- Preserve all numeric thresholds, ranges, units, and conditions exactly.
- Each sentence must be understandable without seeing the table.
- Expand obvious medical shorthand only when unambiguous (e.g. "SpO2 less than 90 percent").
- Output plain sentences only: no markdown, no bullet points, no preamble.

Example:
Table:
| SpO2 | Severity |
|---|---|
| <90 | Critical |
| 90-94 | Moderate |

Output:
SpO2 less than 90 percent indicates Critical severity. SpO2 between 90 and 94 percent indicates Moderate severity.

Table (from "{source}", page {page}, section "{section}"):
{table_md}
"""

_MAX_RETRIES = 4

# Sticky flag: once the free-tier DAILY quota is hit, retries are pointless
# until tomorrow — stop calling the API and use the deterministic fallback.
_daily_quota_exhausted = False


def quota_exhausted() -> bool:
    return _daily_quota_exhausted


def is_daily_quota_error(e: genai_errors.APIError) -> bool:
    return e.code == 429 and "PerDay" in str(e)


def _fallback_conversion(table: RawTable) -> str:
    """Deterministic 'header: value' sentences when the LLM is unavailable."""
    rows = [[(c or "").strip().replace("\n", " ") for c in r] for r in table.rows]
    rows = [r for r in rows if any(r)]
    if len(rows) < 2:
        return " ".join(" ".join(r) for r in rows)
    header, body = rows[0], rows[1:]
    sentences = []
    for row in body:
        parts = [f"{h}: {v}" for h, v in zip(header, row) if h and v]
        if parts:
            sentences.append("; ".join(parts) + ".")
    return " ".join(sentences)


def convert_table(
    client: genai.Client,
    model: str,
    table: RawTable,
    source_document: str,
    section_title: str,
) -> str:
    global _daily_quota_exhausted
    table_md = table.to_markdown()
    if not table_md:
        return ""
    if _daily_quota_exhausted:
        return _fallback_conversion(table)
    prompt = TABLE_PROMPT.format(
        source=source_document,
        page=table.page_number,
        section=section_title or "unknown",
        table_md=table_md,
    )
    for attempt in range(_MAX_RETRIES):
        try:
            resp = client.models.generate_content(model=model, contents=prompt)
            text = (resp.text or "").strip()
            if text:
                return text
            break
        except genai_errors.APIError as e:
            if is_daily_quota_error(e):
                _daily_quota_exhausted = True
                log.warning(
                    "Gemini DAILY quota exhausted — deterministic table conversion for the rest of this run"
                )
                break
            if e.code in (429, 500, 503) and attempt < _MAX_RETRIES - 1:
                wait = 2 ** (attempt + 1)
                log.warning("Gemini table conversion %s, retrying in %ss", e.code, wait)
                time.sleep(wait)
                continue
            log.error("Table conversion failed (page %d): %s", table.page_number, e)
            break
    log.warning("Falling back to deterministic table conversion (page %d)", table.page_number)
    return _fallback_conversion(table)
