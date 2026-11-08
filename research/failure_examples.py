"""Counts and examples for the Failure Modes paragraph, from the run files.

    python3 -I research/failure_examples.py   # writes research/results/failure_examples.json
"""

import json
import re
from collections import Counter
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
OUT = RESULTS / "failure_examples.json"


def load(run):
    path = RESULTS / f"{run}.json"
    if not path.exists():
        return None
    d = json.loads(path.read_text())
    cases = d.get("cases") or d.get("results")
    if len(cases) < 207:
        return None
    return {c["stayId"]: c for c in cases}


def under(c):
    return c["status"] == "ok" and c["predictedEsi"] > c["groundTruthEsi"]


def notice_effect(model):
    """Patients under-triaged with the notice but not without safety and not without the notice."""
    on = load(f"{model}__rag-off__safety-on")
    off = load(f"{model}__rag-off__safety-off")
    quiet = load(f"{model}__rag-off__safety-on__notice-off")
    if not (on and off and quiet):
        return None
    only = [s for s in on if under(on[s]) and not under(off[s]) and not under(quiet[s])]
    phrase = re.compile(r"no (critical )?red flags?", re.I)
    no_rule = [s for s in on if not on[s]["safetyTriggered"]]
    return {
        "underTriagedOnlyWithNotice": len(only),
        "ofThoseReasoningSaysNoRedFlags": sum(1 for s in only if phrase.search(on[s]["reasoning"] or "")),
        "patientsWithoutRule": len(no_rule),
        "reasoningSaysNoRedFlagsWithNotice": sum(1 for s in no_rule if phrase.search(on[s]["reasoning"] or "")),
        "reasoningSaysNoRedFlagsWithoutNotice": sum(1 for s in no_rule if phrase.search(quiet[s]["reasoning"] or "")),
        "examples": [
            {"stayId": s, "nurseEsi": on[s]["groundTruthEsi"], "withNotice": on[s]["predictedEsi"], "noNotice": quiet[s]["predictedEsi"],
             "reasoningWithNotice": on[s]["reasoning"]}
            for s in only[:3]
        ],
    }


def prediction_counts(run):
    cases = load(run)
    if not cases:
        return None
    return dict(sorted(Counter(c["predictedEsi"] for c in cases.values() if c["status"] == "ok").items()))


def esi2_under(run):
    """Where under-triaged ESI 2 patients ended up."""
    cases = load(run)
    if not cases:
        return None
    return dict(sorted(Counter(c["predictedEsi"] for c in cases.values() if c["groundTruthEsi"] == 2 and under(c)).items()))


def main():
    out = {"noticeEffect": {}, "predictedLevels": {}, "esi2UnderTriagedTo": {}}
    for model in ["qwen2.5-7b", "llama3.1-8b", "gemma3-12b", "medgemma-27b"]:
        out["noticeEffect"][model] = notice_effect(model)
        for suffix in ["rag-off__safety-off", "rag-off__safety-off__guide-on", "rag-on__safety-off"]:
            out["predictedLevels"][f"{model}__{suffix}"] = prediction_counts(f"{model}__{suffix}")
        for suffix in ["rag-off__safety-off", "rag-off__safety-on", "rag-on__safety-off", "rag-on__safety-on", "rag-off__safety-on__notice-off"]:
            out["esi2UnderTriagedTo"][f"{model}__{suffix}"] = esi2_under(f"{model}__{suffix}")
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({k: (v if k != "noticeEffect" else {m: (e and {x: y for x, y in e.items() if x != "examples"}) for m, e in v.items()}) for k, v in out.items()}, indent=1))


if __name__ == "__main__":
    main()
