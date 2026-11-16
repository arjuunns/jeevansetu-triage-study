"""Checks computed from the saved run files, with no new model runs (added 15 Nov 2026 after a review).

1. overrideOnly: the hard override on its own. For the setups without safety rules (LLM only, + ESI guide,
   + RAG), every visit where a safety rule fired is set to ESI 1 after the fact, as the reconciliation step
   would do, without any safety text in the prompt. Compared with the saved run (patient-level paired
   permutation test from analyze.py, unadjusted; exploratory).
2. unflaggedAgreement: on the visits where no rule fired, the prompt of "LLM + safety, no notice" is
   byte-identical to that of "LLM only" (apps/server/src/modules/triage/triage.prompts.ts), so any
   difference between the two runs there is run-to-run nondeterminism. Counts those differences, and on the
   flagged visits counts how often the model itself gave ESI 1 in each run.
3. patientWeighted: exact agreement and under-triage with every patient weighted equally (mean over each
   patient's visits, then over the 56 patients), against the visit-weighted values in summary.json.

Writes research/results/robustness_checks.json. Run: python3 -I research/robustness_checks.py
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402

OUT = A.RESULTS / "robustness_checks.json"
MODELS = ["qwen2.5-7b", "llama3.1-8b", "gemma3-12b", "gemma3-27b", "medgemma-27b"]
BASES = {"LLM only": "rag-off__safety-off", "LLM + ESI guide": "rag-off__safety-off__guide-on", "LLM + RAG": "rag-on__safety-off"}
WITH_SAFETY = {"LLM only": "rag-off__safety-on", "LLM + ESI guide": "rag-off__safety-on__guide-on", "LLM + RAG": "rag-on__safety-on"}


def load(name):
    return {r["stayId"]: r for r in json.loads((A.RESULTS / f"{name}.json").read_text())["results"]}


def rate(rows, test):
    return sum(test(r) for r in rows) / len(rows)


def under(r):
    return r["predictedEsi"] > r["groundTruthEsi"]


def exact(r):
    return r["predictedEsi"] == r["groundTruthEsi"]


def patient_weighted(rows, cohort, test):
    by = defaultdict(list)
    for r in rows:
        by[cohort[r["stayId"]]["subjectId"]].append(test(r))
    return sum(sum(v) / len(v) for v in by.values()) / len(by)


def main():
    cohort = A.load_cohort()
    rules = load("rules-only")
    flagged = {s for s, r in rules.items() if r["safetyTriggered"]}
    out = {"flaggedVisits": len(flagged), "overrideOnly": [], "unflaggedAgreement": {}, "patientWeighted": {}}

    for m in MODELS:
        for base, suffix in BASES.items():
            run = load(f"{m}__{suffix}")
            shared = sorted(s for s, r in run.items() if r["status"] == "ok")
            if any(run[s]["safetyTriggered"] != (s in flagged) for s in shared):
                raise SystemExit(f"{m} {base}: safetyTriggered differs from the rules-only run")
            before = [run[s] for s in shared]
            after = [dict(r, predictedEsi=1) if r["stayId"] in flagged else r for r in before]
            subjects = [cohort[s]["subjectId"] for s in shared]
            safety = list(load(f"{m}__{WITH_SAFETY[base]}").values())
            row = {"model": m, "setup": base, "n": len(shared),
                   "changed": sum(a["predictedEsi"] != b["predictedEsi"] for a, b in zip(after, before)),
                   "correctedUnderTriage": sum(under(b) and not under(a) for a, b in zip(after, before)),
                   "nowExact": sum(exact(a) and not exact(b) for a, b in zip(after, before)),
                   "nowOverTriaged": sum(a["predictedEsi"] < a["groundTruthEsi"] and a["predictedEsi"] != b["predictedEsi"]
                                         for a, b in zip(after, before))}
            for name, test in (("underTriage", under), ("exact", exact)):
                xa, xb = [test(r) for r in before], [test(r) for r in after]
                row[name] = {"before": sum(xa) / len(xa), "overrideOnly": sum(xb) / len(xb),
                             "withSafetyRun": rate(safety, test),
                             "pPatient": A.paired_permutation_patient(xa, xb, subjects)}
            out["overrideOnly"].append(row)

        a, b = load(f"{m}__rag-off__safety-off"), load(f"{m}__rag-off__safety-on__notice-off")
        unflagged = [s for s in a if s not in flagged]
        out["unflaggedAgreement"][m] = {
            "unflaggedVisits": len(unflagged),
            "differentAnswers": sum(a[s]["predictedEsi"] != b[s]["predictedEsi"] for s in unflagged),
            "flaggedModelEsi1LlmOnly": sum(a[s]["modelEsi"] == 1 for s in flagged),
            "flaggedModelEsi1NoNotice": sum(b[s]["modelEsi"] == 1 for s in flagged),
            "flaggedOverriddenNoNotice": sum(bool(b[s]["safetyOverridden"]) for s in flagged),
        }

    for path in sorted(A.RESULTS.glob("*__*.json")) + [A.RESULTS / "rules-only.json"]:
        rows = [r for r in json.loads(path.read_text())["results"] if r["status"] == "ok"]
        out["patientWeighted"][path.stem] = {
            "exactVisit": rate(rows, exact), "exactPatient": patient_weighted(rows, cohort, exact),
            "underTriageVisit": rate(rows, under), "underTriagePatient": patient_weighted(rows, cohort, under)}
    always2 = [{"stayId": s, "groundTruthEsi": r["groundTruthEsi"], "predictedEsi": 2} for s, r in rules.items()]
    out["patientWeighted"]["always-esi-2"] = {
        "exactVisit": rate(always2, exact), "exactPatient": patient_weighted(always2, cohort, exact),
        "underTriageVisit": rate(always2, under), "underTriagePatient": patient_weighted(always2, cohort, under)}

    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
