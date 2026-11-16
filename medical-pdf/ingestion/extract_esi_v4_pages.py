"""Cuts the pages of the ESI v4 handbook that form the pipeline v2 retrieval corpus.

The corpus holds chapters 2 to 6 and Appendix B of Emergency Severity Index (ESI): A Triage Tool for Emergency
Department Care, Version 4, Implementation Handbook, 2012 Edition (AHRQ Publication No. 12-0014): pages 16 to 60
and 109 to 110 of the 114-page PDF published by AHRQ. Run from this folder:

    .venv/bin/python extract_esi_v4_pages.py <full handbook PDF> ../Emergency_Severity_Index_v4_Handbook_2012.pdf
    .venv/bin/python local_ingest.py --pdf ../Emergency_Severity_Index_v4_Handbook_2012.pdf \
        --out index_v4/guidelines.metadata.jsonl

local_ingest.py then gives the same 88 passages, with the same chunk IDs, as the study's corpus (checked 16 Nov 2026).
"""

import sys

import pymupdf

PAGES = [(16, 60), (109, 110)]  # 1-based, inclusive


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src = pymupdf.open(sys.argv[1])
    if src.page_count != 114:
        raise SystemExit(f"expected the 114-page AHRQ PDF, got {src.page_count} pages")
    out = pymupdf.open()
    for first, last in PAGES:
        out.insert_pdf(src, from_page=first - 1, to_page=last - 1)
    out.save(sys.argv[2])
    print(f"wrote {out.page_count} pages to {sys.argv[2]}")


if __name__ == "__main__":
    main()
