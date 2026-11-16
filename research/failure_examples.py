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


URGENCY = {
    # Words the model uses for the urgency it intends, next to the level it gives (11 Nov 2026).
    "high": re.compile(r"\b(high|elevated|urgent|higher) (triage|acuity|esi|priority|level)"),
    "moderate": re.compile(r"\bmoderate (triage|acuity|esi|priority|level)"),
}


def urgency_words(run):
    """Per predicted level: how many explanations ask for a 'high' or a 'moderate' level."""
    rows = load(run)
    if rows is None:
        return None
    out = {}
    for r in rows.values():
        if r["status"] != "ok":
            continue
        text = (r["reasoning"] or "").lower()
        word = "high" if URGENCY["high"].search(text) else "moderate" if URGENCY["moderate"].search(text) else "neither"
        level = out.setdefault(str(r["predictedEsi"]), {"high": 0, "moderate": 0, "neither": 0})
        level[word] += 1
    return out


def guide_reasons():
    """What the models wrote when the ESI guide was in the prompt (pipeline v2 runs, 11 Nov 2026)."""
    out = {}
    q = load("qwen2.5-7b__rag-off__safety-off__guide-on")
    if q:
        esi1 = [(r["reasoning"] or "").lower() for r in q.values() if r["status"] == "ok" and r["predictedEsi"] == 1 and r["groundTruthEsi"] >= 2]
        out["qwen2.5-7b"] = {
            "esi1AnswersForNurseEsi2to5": len(esi1),
            "citeDangerZoneOrSeverePain": sum(("danger zone" in t) or ("severe pain" in t) for t in esi1),
            "citeDangerZone": sum("danger zone" in t for t in esi1),
            "citeSeverePain": sum("severe pain" in t for t in esi1),
        }
    l = load("llama3.1-8b__rag-off__safety-off__guide-on")
    if l:
        esi5 = [(r["reasoning"] or "").lower() for r in l.values() if r["status"] == "ok" and r["predictedEsi"] == 5]
        pat = re.compile(r"one or fewer|fewer than (two|2)|no resources|zero resources|one resource")
        out["llama3.1-8b"] = {"esi5Answers": len(esi5), "citeOneOrFewerResources": sum(bool(pat.search(t)) for t in esi5)}
    g = load("gemma3-12b__rag-off__safety-off__guide-on")
    if g:
        pat = re.compile(r"decision point|last open bed|danger zone|esi guideline")
        texts = [(r["reasoning"] or "").lower() for r in g.values() if r["status"] == "ok"]
        out["gemma3-12b"] = {"answers": len(texts), "citeDecisionPointsOrGuide": sum(bool(pat.search(t)) for t in texts)}
    for model in ["gemma3-27b", "medgemma-27b"]:  # added 15 Nov 2026 with the GPU runs; same count as for gemma3-12b
        m = load(f"{model}__rag-off__safety-off__guide-on")
        if m:
            pat = re.compile(r"decision point|last open bed|danger zone|esi guideline")
            texts = [(r["reasoning"] or "").lower() for r in m.values() if r["status"] == "ok"]
            out[model] = {"answers": len(texts), "citeDecisionPointsOrGuide": sum(bool(pat.search(t)) for t in texts)}
    return out


def main():
    out = {"noticeEffect": {}, "predictedLevels": {}, "esi2UnderTriagedTo": {}, "urgencyWordsByLevel": {}}
    for model in ["qwen2.5-7b", "llama3.1-8b", "gemma3-12b", "gemma3-27b", "medgemma-27b"]:
        out["noticeEffect"][model] = notice_effect(model)
        for suffix in ["rag-off__safety-off", "rag-off__safety-off__guide-on", "rag-on__safety-off"]:
            out["predictedLevels"][f"{model}__{suffix}"] = prediction_counts(f"{model}__{suffix}")
            out["urgencyWordsByLevel"][f"{model}__{suffix}"] = urgency_words(f"{model}__{suffix}")
        for suffix in ["rag-off__safety-off", "rag-off__safety-on", "rag-on__safety-off", "rag-on__safety-on", "rag-off__safety-on__notice-off"]:
            out["esi2UnderTriagedTo"][f"{model}__{suffix}"] = esi2_under(f"{model}__{suffix}")
    out["guideReasons"] = guide_reasons()
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({k: (v if k != "noticeEffect" else {m: (e and {x: y for x, y in e.items() if x != "examples"}) for m, e in v.items()}) for k, v in out.items()}, indent=1))


if __name__ == "__main__":
    main()
