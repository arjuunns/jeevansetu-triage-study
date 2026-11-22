"""Extracts the practice and competency cases of the ESI v4 handbook as a second test set.

    research/.venv-ext/bin/python -I research/handbook_cases.py            # data/esi_handbook_cases.json
    research/.venv-ext/bin/python -I research/handbook_cases.py --check    # also the check and overlap reports

Source: Emergency Severity Index (ESI): A Triage Tool for Emergency Department Care, Version 4,
Implementation Handbook, 2012 Edition (AHRQ Publication No. 12-0014), the 114-page PDF published
by AHRQ. Chapter 9 (PDF pages 77 to 90) has 100 practice cases followed by their answers;
Chapter 10 (pages 91 to 97) has two sets of 25 competency cases, Set A and Set B, followed by
their answers. The answer to each case is the ESI level given by the handbook's authors.

The output has the schema of data/mimic_ed_cohort.json (research/build_cohort.py), so the same
evaluation code reads it:

  * `stayId` is the case id: P001 to P100 (practice), CA001 to CA025 and CB001 to CB025
    (competency sets A and B). `subjectId` is the same id: every case is a different patient.
  * `input.chiefComplaint` holds the FULL vignette text, because the vignettes are free text and
    not triage records. `input.arrivalTransport` is empty: the way of arrival is not extracted,
    it stays in the vignette where the handbook mentions it.
  * `input.age` is the age in years (months, weeks and days as a fraction of a year), or null
    when the vignette gives no age. `input.ageText` ("2 weeks", "18 months", "not stated") is set
    only when the age is not a whole number of years; the prompt then shows it instead of the
    number.
  * `input.gender` is FEMALE or MALE where the vignette states the patient's sex by a noun or a
    pronoun, or implies it by pregnancy or childbirth; otherwise "NOT STATED".
  * `input.vitals` and `input.painScore` hold every vital sign and pain score the vignette gives
    as a number. Missing values stay missing. As in build_cohort.py, physiologically implausible
    values and pain entries that are not a whole number from 0 to 10 are set to missing and
    listed in `meta.droppedImplausibleValues`. The Glasgow Coma Scale (two cases) is not
    extracted because the cohort schema has no such field.
  * `label.esi` is the official level. `outcome.officialAnswer` holds the handbook's explanation,
    for error analysis only; like `outcome` in the MIMIC cohort it must never reach a model.
  * A case whose official answer names two levels has no single reference level and is left out
    (listed in `meta.excludedCases`).

The file contains handbook text (copyright of the publisher of the handbook) and stays in the
private repository. This script contains none of it, so readers can rebuild the file from their
own copy of the PDF. Needs PyMuPDF (pip install pymupdf).
"""

import argparse
import json
import re
from collections import Counter
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "medical-pdf" / "originals" / "ESI_v4_Implementation_Handbook_2012_AHRQ_12-0014_full.pdf"
OUT = ROOT / "data" / "esi_handbook_cases.json"
CORPUS = ROOT / "medical-pdf" / "ingestion" / "index_v4" / "guidelines.metadata.jsonl"
GUIDE = ROOT / "apps" / "server" / "src" / "modules" / "triage" / "esi.guide.ts"
CHECK_MD = ROOT / "research" / "results_ext" / "handbook_cases_check.md"
OVERLAP_JSON = ROOT / "research" / "results_ext" / "handbook_overlap_check.json"
HANDCHECK = ROOT / "research" / "results_ext" / "handbook_cases_handcheck.tsv"

CHAPTER9_PAGES = (77, 90)   # 1-based, inclusive
CHAPTER10_PAGES = (91, 97)
SHINGLE = 50

# Same plausible ranges as research/build_cohort.py.
RANGES = {
    "temperatureF": (90, 110),
    "heartRate": (20, 250),
    "respiratoryRate": (4, 60),
    "oxygenSaturation": (50, 100),
    "systolicBp": (50, 300),
    "diastolicBp": (20, 200),
}
NUMBER_WORDS = {w: i + 1 for i, w in enumerate(
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen".split())}

# Sex, where the rules below cannot decide from the vignette. Found in the hand check of all
# cases against the PDF (research/results_ext/handbook_cases_check.md); each entry gives the reason.
SEX_OVERRIDES = {
    "P014": ("MALE", "pronoun", "two people are referred to by pronouns; the masculine ones are the infant's"),
    "P048": ("FEMALE", "implied", "post partum patient; no noun or pronoun for the patient"),
    "P058": ("NOT STATED", "not stated", "the only pronoun refers to the patient's doctor"),
    "P078": ("FEMALE", "implied", "the patient is a nursing mother; no other noun or pronoun"),
}
# Children whose vignette gives no age (counted as paediatric).
PAEDIATRIC_WITHOUT_AGE = {"CA006": "a child brought by a parent on the advice of the paediatrician; no age given"}


# ── reading the PDF ──────────────────────────────────────────────────────────

def page_lines(doc, first, last):
    """(page number, line) for the given pages, without the running footer."""
    out = []
    for number in range(first, last + 1):
        lines = [ln.strip() for ln in doc[number - 1].get_text().split("\n")]
        while lines and not lines[-1]:
            lines.pop()
        if len(lines) >= 2 and re.match(r"^Chapter (9|10)\. ", lines[-1]) and lines[-2].isdigit():
            lines = lines[:-2]
        out += [(number, ln) for ln in lines if ln]
    return out


def section(lines, start, end=None):
    """Lines after the heading line(s) `start` and before the heading `end`."""
    def find(heading, begin):
        for i in range(begin, len(lines) - len(heading) + 1):
            if all(lines[i + k][1] == h for k, h in enumerate(heading)):
                return i
        raise SystemExit(f"heading {heading} not found: is this the 114-page AHRQ PDF?")
    a = find(start, 0) + len(start)
    b = find(end, a) if end else len(lines)
    return lines[a:b]


def split_items(lines, expected_count, what):
    """Numbered items 1..n. A new item starts on a line that begins with the next number in sequence."""
    items, current, expected = {}, None, 1
    for page, line in lines:
        m = re.match(r"^(\d{1,3})(\.)?(?:\s+(.*))?$", line)
        if m and int(m.group(1)) == expected and (m.group(2) or m.group(3) is None):
            current = expected
            items[current] = {"page": page, "lines": [m.group(3)] if m.group(3) else []}
            expected += 1
        elif current is not None:
            items[current]["lines"].append(line)
    if len(items) != expected_count:
        raise SystemExit(f"{what}: found {len(items)} items, expected {expected_count}")
    return items


def join_lines(lines):
    """One paragraph; a compound word split at a line-end hyphen is rejoined without a space."""
    out = ""
    for line in lines:
        if out and out[-1] in "-–" and len(out) > 1 and out[-2] != " ":
            out += line
        else:
            out += (" " if out else "") + line
    return re.sub(r"\s+", " ", out).strip()


# ── parsing a vignette ───────────────────────────────────────────────────────

AGE_RE = re.compile(
    r"\b(\d{1,3}|" + "|".join(NUMBER_WORDS) + r")\s*[-–]?\s*(year|month|week|day)\s*[-–]?\s*old", re.I)


def parse_age(text):
    m = AGE_RE.search(text)
    if not m:
        return None, "not stated"
    raw = m.group(1).lower()
    n = int(raw) if raw.isdigit() else NUMBER_WORDS[raw]
    unit = m.group(2).lower()
    if unit == "year":
        return n, None
    years = {"month": n / 12, "week": n * 7 / 365.25, "day": n / 365.25}[unit]
    return round(years, 4), f"{n} {unit}{'' if n == 1 else 's'}"


FEMALE_NOUNS, MALE_NOUNS = r"\b(female|woman|girl)\b", r"\b(male|man|boy)\b"


def parse_sex(case_id, text):
    """(gender, source). Source: explicit noun, child noun, pronoun, implied, or not stated."""
    if case_id in SEX_OVERRIDES:
        return SEX_OVERRIDES[case_id][:2]
    age = AGE_RE.search(text)
    if age:  # "a 34-year-old obese female"
        m = re.match(r"[-–’'s]*\s+(?:[\w-]+\s+){0,3}?(female|woman|girl|male|man|boy)\b", text[age.end():], re.I)
        if m:
            return ("FEMALE" if m.group(1).lower() in ("female", "woman", "girl") else "MALE"), "explicit"
    f, m_ = bool(re.search(FEMALE_NOUNS, text, re.I)), bool(re.search(MALE_NOUNS, text, re.I))
    if f != m_:
        return ("FEMALE" if f else "MALE"), "explicit"
    f, m_ = bool(re.search(r"\bdaughter\b", text, re.I)), bool(re.search(r"\bson\b", text, re.I))
    if f != m_:
        return ("FEMALE" if f else "MALE"), "explicit"
    f, m_ = bool(re.search(r"\b(she|her|hers|herself)\b", text, re.I)), bool(re.search(r"\b(he|him|his|himself)\b", text, re.I))
    if f != m_:
        return ("FEMALE" if f else "MALE"), "pronoun"
    return "NOT STATED", ("ambiguous" if f and m_ else "not stated")


VITAL_PATTERNS = {
    "temperatureF": [r"(?:\bT\.?|[Tt]emperature(?: of)?)\s*(\d{2,3}(?:\.\d+)?)\s*[˚°]\s*F"],
    "heartRate": [r"\b(?:HR|P)\s+(?:is\s+|was\s+)?(\d{2,3})\b", r"\bheart rate (?:is|was|of) (\d{2,3})\b"],
    "respiratoryRate": [r"\bRR\s*(\d{1,2})\b", r"\brespiratory rate (?:is|was|of) (\d{1,2})\b"],
    "oxygenSaturation": [r"(?:SpO2|SPO2|saturation)\D{0,25}?(\d{2,3})\s*(?:%|percent)"],
}
BP_RE = re.compile(r"\b(?:BP|blood pressure)\s*(?:of|was|is)?\s*(\d{2,3})\s*/\s*(\d{2,3}|palp)\b")
PAIN_RES = [re.compile(r"(?<![\d/])(\d{1,2}\+?)\s*/\s*10(?!\d)"), re.compile(r"[“\"]?(\d{1,2})[”\"]?\s+out of\s+10\b")]


def parse_vitals(case_id, text, dropped, notes):
    """Vital signs and pain score as in the cohort file. When a sign is given twice, the last value is used."""
    raw = {}
    for key, patterns in VITAL_PATTERNS.items():
        found = sorted((m.start(), m.group(1)) for p in patterns for m in re.finditer(p, text))
        if found:
            raw[key] = float(found[-1][1])
            if len(found) > 1:
                notes.append(f"{key} given {len(found)} times ({', '.join(v for _, v in found)}); last used")
    bps = list(BP_RE.finditer(text))
    if bps:
        raw["systolicBp"] = float(bps[-1].group(1))
        if bps[-1].group(2) != "palp":
            raw["diastolicBp"] = float(bps[-1].group(2))
        else:
            notes.append("blood pressure by palpation: systolic only")
        if len(bps) > 1:
            notes.append(f"blood pressure given {len(bps)} times ({', '.join(m.group(1) + '/' + m.group(2) for m in bps)}); last used")

    vitals = {}
    for key in ("heartRate", "respiratoryRate", "oxygenSaturation", "systolicBp", "diastolicBp", "temperatureF"):
        if key not in raw:
            continue
        low, high = RANGES[key]
        if not low <= raw[key] <= high:
            dropped.append({"stayId": case_id, "field": key, "raw": f"{raw[key]:g}"})
            notes.append(f"{key} {raw[key]:g} implausible: set to missing")
            continue
        if key == "temperatureF":
            vitals["temperatureC"] = round((raw[key] - 32) * 5 / 9, 1)
        else:
            vitals[key] = int(round(raw[key]))

    pains = sorted((m.start(), m.group(1)) for p in PAIN_RES for m in p.finditer(text))
    pain = None
    if pains:
        value = pains[0][1]
        if value.isdigit() and 0 <= int(value) <= 10:
            pain = int(value)
        else:
            dropped.append({"stayId": case_id, "field": "pain", "raw": value})
            notes.append(f"pain {value}/10 is not a whole number from 0 to 10: set to missing")
        if len({v for _, v in pains}) > 1:
            notes.append(f"pain given more than once ({', '.join(v for _, v in pains)}); first used")
    return vitals, pain


# ── building the case set ────────────────────────────────────────────────────

def read_cases(pdf):
    doc = pymupdf.open(pdf)
    if doc.page_count != 114:
        raise SystemExit(f"expected the 114-page AHRQ PDF, got {doc.page_count} pages")
    ch9 = page_lines(doc, *CHAPTER9_PAGES)
    ch10 = page_lines(doc, *CHAPTER10_PAGES)
    answers9 = ["Practice Cases Answers and", "Discussion"]
    a_answers = ["Set A Competency Cases—", "Answers"]
    b_answers = ["Set B Competency Cases—", "Answers"]
    sets = [
        ("P", "Chapter 9, practice cases", 100, section(ch9, ["Practice Cases"], answers9), section(ch9, answers9)),
        ("CA", "Chapter 10, competency cases, Set A", 25,
         section(ch10, ["Set A Competency Cases"], ["Set B Competency Cases"]), section(ch10, a_answers, b_answers)),
        ("CB", "Chapter 10, competency cases, Set B", 25,
         section(ch10, ["Set B Competency Cases"], a_answers), section(ch10, b_answers)),
    ]
    cases, excluded, dropped, extraction = [], [], [], {}
    for prefix, name, count, case_lines, answer_lines in sets:
        vignettes = split_items(case_lines, count, f"{name}: cases")
        answers = split_items(answer_lines, count, f"{name}: answers")
        for number in range(1, count + 1):
            case_id = f"{prefix}{number:03d}"
            text = join_lines(vignettes[number]["lines"])
            answer = join_lines(answers[number]["lines"])
            level = re.match(r"ESI level (\d)(?: or (\d))?\b", answer)
            if not level:
                raise SystemExit(f"{case_id}: the answer does not start with an ESI level")
            notes = []
            age, age_text = parse_age(text)
            gender, sex_source = parse_sex(case_id, text)
            if case_id in SEX_OVERRIDES:
                notes.append(f"sex set by hand: {SEX_OVERRIDES[case_id][2]}")
            vitals, pain = parse_vitals(case_id, text, dropped, notes)
            paediatric = (age is not None and age < 18) or case_id in PAEDIATRIC_WITHOUT_AGE
            if case_id in PAEDIATRIC_WITHOUT_AGE:
                notes.append(f"paediatric without a stated age: {PAEDIATRIC_WITHOUT_AGE[case_id]}")
            source = {"set": name, "number": number, "casePage": vignettes[number]["page"], "answerPage": answers[number]["page"]}
            extraction[case_id] = {"level": level.group(0), "sexSource": sex_source, "paediatric": paediatric, "notes": notes,
                                   "source": source, "age": age, "ageText": age_text, "gender": gender, "vitals": vitals,
                                   "pain": pain, "chars": len(text)}
            if level.group(2):
                excluded.append({"stayId": case_id, "reason": f"the official answer names two levels ({level.group(1)} or {level.group(2)})"})
                dropped[:] = [d for d in dropped if d["stayId"] != case_id]
                continue
            cases.append({
                "stayId": case_id,
                "subjectId": case_id,
                "input": {
                    "age": age,
                    **({"ageText": age_text} if age_text else {}),
                    "gender": gender,
                    "arrivalTransport": "",
                    "chiefComplaint": text,
                    "vitals": vitals,
                    "painScore": pain,
                },
                "label": {"esi": int(level.group(1))},
                "outcome": {"disposition": "", "dischargeDiagnoses": [], "officialAnswer": answer},
                "source": source,
                "paediatric": paediatric,
                "sexSource": sex_source,
            })
    return cases, excluded, dropped, extraction


def build(pdf):
    cases, excluded, dropped, extraction = read_cases(pdf)
    counts = Counter(c["label"]["esi"] for c in cases)
    meta = {
        "source": "Emergency Severity Index (ESI) Version 4 Implementation Handbook, 2012 Edition (AHRQ Publication No. 12-0014): "
                  "Chapter 9 practice cases (PDF pages 77-90) and Chapter 10 competency cases, Sets A and B (pages 91-97)",
        "generatedBy": "research/handbook_cases.py",
        "inclusion": "every practice and competency case whose official answer gives one ESI level",
        "excludedCases": excluded,
        "n": len(cases),
        "nBySet": dict(Counter(c["source"]["set"] for c in cases)),
        "esiCounts": {str(k): v for k, v in sorted(counts.items())},
        "paediatric": sum(c["paediatric"] for c in cases),
        "paediatricDefinition": "stated age under 18 years, or a child without a stated age (PAEDIATRIC_WITHOUT_AGE in the script)",
        "casesWithNoStatedAge": sum(c["input"]["age"] is None for c in cases),
        "casesWithSexNotStated": sum(c["input"]["gender"] == "NOT STATED" for c in cases),
        "casesWithNoTriageVitals": sum(1 for c in cases if not c["input"]["vitals"]),
        "casesWithNoPainScore": sum(c["input"]["painScore"] is None for c in cases),
        "droppedImplausibleValues": dropped,
        "chiefComplaintIsFullVignette": True,
        "notes": [
            "The vignettes are free text, not triage records: input.chiefComplaint holds the full vignette text, "
            "so the age, sex, vital signs and pain score parsed into the other fields also appear in that text.",
            "input.arrivalTransport is empty for every case (not extracted).",
            "input.age is in years (fractions for infants); input.ageText is set when the age is not a whole number of years or is not stated.",
            "label.esi is the level given by the handbook's authors; outcome.officialAnswer is their explanation and must never reach a model.",
            "subjectId equals stayId: every case is a different patient.",
            "The Glasgow Coma Scale is not extracted (the cohort schema has no such field).",
            "This file contains handbook text and must stay in the private repository.",
        ],
    }
    return {"meta": meta, "cases": cases}, extraction


# ── checks ───────────────────────────────────────────────────────────────────

def normalise(text):
    text = text.lower()
    for a, b in (("“", '"'), ("”", '"'), ("’", "'"), ("‘", "'"), ("–", "-"), ("—", "-"),
                 ("˚", "°")):
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


def shingles(text, size=SHINGLE):
    t = normalise(text)
    return {t[i:i + size] for i in range(max(0, len(t) - size + 1))}


def overlap_check(data):
    """Character shingles of every vignette and official answer against the retrieval corpus.

    The corpus is every passage retrieval can return: the passages of the index and the curated
    ESI guide (apps/server/src/modules/triage/esi.guide.ts). The main check uses 50-character
    shingles; 40 and 30 characters are reported as well to show how short the shared phrases are.
    """
    corpus = [json.loads(line) for line in CORPUS.read_text().splitlines() if line.strip()]
    guide = re.search(r"ESI_ALGORITHM_GUIDE = `(.*?)`;", GUIDE.read_text(), re.S).group(1)
    passages = [(c["id"], c["content"]) for c in corpus] + [("curated-esi-guide", guide)]
    result = {"corpus": str(CORPUS.relative_to(ROOT)), "corpusChunks": len(corpus), "curatedGuideIncluded": True,
              "normalisation": "lower case, straight quotes and hyphens, single spaces", "cases": len(data["cases"]), "bySize": {}}
    for size in (50, 40, 30):
        index = {}
        for pid, text in passages:
            for s in shingles(text, size):
                index.setdefault(s, pid)
        found = {"vignettesWithOverlap": [], "answersWithOverlap": []}
        for c in data["cases"]:
            for text, key in ((c["input"]["chiefComplaint"], "vignettesWithOverlap"), (c["outcome"]["officialAnswer"], "answersWithOverlap")):
                own = shingles(text, size)
                shared = [s for s in own if s in index]
                if shared:
                    found[key].append({"stayId": c["stayId"], "sharedShingles": len(shared), "ofShingles": len(own),
                                       "passages": sorted({index[s] for s in shared})})
        result["bySize"][str(size)] = {
            "nVignettesWithOverlap": len(found["vignettesWithOverlap"]),
            "nAnswersWithOverlap": len(found["answersWithOverlap"]),
            "mostSharedShinglesInOneVignette": max((x["sharedShingles"] for x in found["vignettesWithOverlap"]), default=0),
            "mostSharedShinglesInOneAnswer": max((x["sharedShingles"] for x in found["answersWithOverlap"]), default=0),
            **(found if size == SHINGLE else {}),
        }
    # The same 50-character check between the vignettes themselves, to find repeated cases.
    seen, repeats = {}, {}
    for c in data["cases"]:
        for s in shingles(c["input"]["chiefComplaint"]):
            other = seen.setdefault(s, c["stayId"])
            if other != c["stayId"]:
                repeats[(other, c["stayId"])] = repeats.get((other, c["stayId"]), 0) + 1
    result["casePairsSharingA50CharShingle"] = [{"cases": list(p), "sharedShingles": n} for p, n in repeats.items()]
    return result


def load_handcheck():
    rows = {}
    for line in HANDCHECK.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        cid, esi, age, sex, temp, hr, rr, spo2, bp, pain = line.split("\t")
        rows[cid] = dict(esi=esi, age=age, sex=sex, temp=temp, hr=hr, rr=rr, spo2=spo2, bp=bp, pain=pain)
    return rows


def as_handcheck(case_id, e, text_values):
    """The parser's values in the notation of the hand-keyed table (raw values before range checks)."""
    age = "-"
    if e["age"] is not None:
        age = {"day": "d", "week": "w", "month": "m"}.get((e["ageText"] or "x y").split()[1].rstrip("s"), "y")
        age = f"{(e['ageText'] or str(e['age'])).split()[0]}{age}"
    return dict(
        esi=e["level"].replace("ESI level ", "").replace(" or ", "or"),
        age=age,
        sex={"FEMALE": "F", "MALE": "M"}.get(e["gender"], "-"),
        **text_values,
    )


def raw_values(text):
    """Raw printed values (before range checks and unit conversion), for comparison with the hand-keyed table."""
    def last(patterns):
        found = sorted((m.start(), m.group(1)) for p in patterns for m in re.finditer(p, text))
        return f"{float(found[-1][1]):g}" if found else "-"
    bps = list(BP_RE.finditer(text))
    pains = sorted((m.start(), m.group(1)) for p in PAIN_RES for m in p.finditer(text))
    return dict(
        temp=last(VITAL_PATTERNS["temperatureF"]), hr=last(VITAL_PATTERNS["heartRate"]), rr=last(VITAL_PATTERNS["respiratoryRate"]),
        spo2=last(VITAL_PATTERNS["oxygenSaturation"]), bp=f"{bps[-1].group(1)}/{bps[-1].group(2)}" if bps else "-",
        pain=pains[0][1] if pains else "-",
    )


def write_check(data, extraction, pdf):
    hand = load_handcheck()
    doc_cases = {c["stayId"]: c for c in data["cases"]}
    # Vignettes of excluded cases are not in the output file; read them again for the comparison.
    all_text = {}
    cases, _, _, _ = read_cases(pdf)
    for c in cases:
        all_text[c["stayId"]] = c["input"]["chiefComplaint"]
    mismatches, rows = 0, []
    for case_id, e in extraction.items():
        text = all_text.get(case_id)
        got = as_handcheck(case_id, e, raw_values(text) if text is not None else {k: hand[case_id][k] for k in ("temp", "hr", "rr", "spo2", "bp", "pain")})
        want = hand.get(case_id)
        diff = [f"{k}: parser {got[k]}, hand {want[k]}" for k in got if want is None or got[k] != want[k]]
        mismatches += bool(diff)
        v = e["vitals"]
        vit = ", ".join(f"{label} {v[k]}" for k, label in (("heartRate", "HR"), ("respiratoryRate", "RR"), ("oxygenSaturation", "SpO2"),
                                                           ("systolicBp", "SBP"), ("diastolicBp", "DBP"), ("temperatureC", "T (C)")) if k in v) or "none"
        age = "not stated" if e["age"] is None else (e["ageText"] or f"{e['age']} years")
        status = "excluded" if case_id not in doc_cases else "included"
        rows.append(f"| {case_id} | p. {e['source']['casePage']} / {e['source']['answerPage']} | {e['level'].replace('ESI level ', '')} | {age} | "
                    f"{e['gender']} ({e['sexSource']}) | {'yes' if e['paediatric'] else 'no'} | {vit} | "
                    f"{'-' if e['pain'] is None else e['pain']} | {status} | {'; '.join(e['notes']) or '-'} | "
                    f"{'matches' if not diff else 'MISMATCH: ' + '; '.join(diff)} |")
    m = data["meta"]
    lines = [
        "# Handbook cases: check of every case against the PDF",
        "",
        "Generated by `research/handbook_cases.py --check`. Do not edit by hand.",
        "",
        "Every case was read in the PDF text (pages 77 to 97) and its official level, age, sex, vital signs and pain score were keyed by hand into "
        "`research/results_ext/handbook_cases_handcheck.tsv`, without looking at the parser's output. The last column compares the parser with that table, "
        "on the values as printed in the handbook (before range checks and the conversion to Celsius).",
        "",
        f"- Cases in the handbook: {len(extraction)} (100 practice, 25 in competency Set A, 25 in Set B).",
        f"- Cases in `data/esi_handbook_cases.json`: {m['n']} ({', '.join(f'{k}: {v}' for k, v in m['nBySet'].items())}).",
        f"- Left out: {', '.join(x['stayId'] + ' (' + x['reason'] + ')' for x in m['excludedCases']) or 'none'}.",
        f"- Official ESI level, included cases: {', '.join(f'ESI {k}: {v}' for k, v in m['esiCounts'].items())}.",
        f"- Paediatric (under 18, or a child with no stated age): {m['paediatric']} of {m['n']}.",
        f"- No stated age: {m['casesWithNoStatedAge']}. Sex not stated: {m['casesWithSexNotStated']}. No vital sign given as a number: {m['casesWithNoTriageVitals']}. "
        f"No usable pain score: {m['casesWithNoPainScore']}.",
        f"- Values set to missing as implausible or not a 0 to 10 pain score: {', '.join(d['stayId'] + ' ' + d['field'] + ' ' + d['raw'] for d in m['droppedImplausibleValues']) or 'none'}.",
        f"- Cases where the parser and the hand-keyed table differ: {mismatches} of {len(extraction)}.",
        "",
        "| Case | Pages (case / answer) | Official ESI | Age | Sex (how stated) | Paediatric | Extracted vital signs | Pain | In the set | Notes | Hand check |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
        *rows,
    ]
    CHECK_MD.parent.mkdir(parents=True, exist_ok=True)
    CHECK_MD.write_text("\n".join(lines) + "\n")
    return mismatches


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pdf", type=Path, default=PDF)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--check", action="store_true", help="also write the hand-check comparison and the overlap check")
    args = ap.parse_args()

    data, extraction = build(args.pdf)
    args.out.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    m = data["meta"]
    print(f"Wrote {args.out}: {m['n']} cases, ESI {m['esiCounts']}, paediatric {m['paediatric']}, excluded {[x['stayId'] for x in m['excludedCases']]}")
    if args.check:
        mismatches = write_check(data, extraction, args.pdf)
        print(f"Wrote {CHECK_MD.relative_to(ROOT)}: {mismatches} cases differ from the hand-keyed table")
        overlap = overlap_check(data)
        OVERLAP_JSON.write_text(json.dumps(overlap, indent=2) + "\n")
        o50 = overlap["bySize"]["50"]
        print(f"Wrote {OVERLAP_JSON.relative_to(ROOT)}: 50-character shingles shared with the corpus: {o50['nVignettesWithOverlap']} vignettes "
              f"(at most {o50['mostSharedShinglesInOneVignette']} shingles), {o50['nAnswersWithOverlap']} answers; "
              f"case pairs sharing text {len(overlap['casePairsSharingA50CharShingle'])}")


if __name__ == "__main__":
    main()
