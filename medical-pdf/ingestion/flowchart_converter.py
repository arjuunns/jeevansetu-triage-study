"""Convert flowchart/diagram pages into structured text decision trees.

Flowchart-candidate pages are rendered to PNG and sent to a multimodal
Gemini model. The model is instructed to preserve every branch, threshold,
condition and outcome — never to summarize. Pages the model judges to
contain no decision diagram return None so false-positive candidates do
not pollute the index.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from pdf_parser import render_page_png

log = logging.getLogger(__name__)

NO_FLOWCHART_SENTINEL = "NO_FLOWCHART"

FLOWCHART_PROMPT = f"""Convert this medical flowchart into a structured text decision tree.

Requirements:
- Preserve every decision branch.
- Preserve thresholds.
- Preserve conditions.
- Preserve outcomes.
- Output markdown.
- Do not summarize.

Use indented IF / ELSE pseudo-logic, for example:

IF chest pain:
    IF SpO2 < 90:
        TRIAGE = Category 1
    ELSE:
        TRIAGE = Category 2

If the image contains NO flowchart, decision tree, triage algorithm, or
clinical diagram (e.g. it is plain text, a photo, or a decorative figure),
reply with exactly: {NO_FLOWCHART_SENTINEL}
"""

_MAX_RETRIES = 4

# Sticky flag: once the free-tier DAILY quota for the vision model is hit,
# remaining flowchart pages are skipped (and recorded by main.py for a
# follow-up run) instead of burning retries.
_daily_quota_exhausted = False


def quota_exhausted() -> bool:
    return _daily_quota_exhausted


def convert_flowchart_page(
    client: genai.Client,
    model: str,
    pdf_path: Path,
    page_number: int,
) -> str | None:
    """Returns the markdown decision tree, or None if the page has none."""
    global _daily_quota_exhausted
    if _daily_quota_exhausted:
        return None
    png = render_page_png(pdf_path, page_number)
    contents = [
        types.Part.from_bytes(data=png, mime_type="image/png"),
        FLOWCHART_PROMPT,
    ]
    for attempt in range(_MAX_RETRIES):
        try:
            resp = client.models.generate_content(model=model, contents=contents)
            text = (resp.text or "").strip()
            if not text or NO_FLOWCHART_SENTINEL in text[:40]:
                log.info("Page %d of %s: no flowchart per model", page_number, pdf_path.name)
                return None
            return text
        except genai_errors.APIError as e:
            if e.code == 429 and "PerDay" in str(e):
                _daily_quota_exhausted = True
                log.warning(
                    "Gemini DAILY quota exhausted — skipping remaining flowchart pages this run"
                )
                return None
            if e.code in (429, 500, 503) and attempt < _MAX_RETRIES - 1:
                wait = 2 ** (attempt + 1)
                log.warning("Gemini flowchart conversion %s, retrying in %ss", e.code, wait)
                time.sleep(wait)
                continue
            log.error("Flowchart conversion failed (%s p%d): %s", pdf_path.name, page_number, e)
            return None
    return None
