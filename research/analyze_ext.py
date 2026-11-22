"""Statistics for the extension experiments (branch experiments-v3, from 16 Nov 2026).

    research/.venv-ext/bin/python -I research/analyze_ext.py

Reads the paper's runs (research/results/, read only) and the new runs (research/results_ext/) and
writes research/results_ext/summary_ext.json and summary_ext.md. analyze.py is imported for the
metric definitions, bootstrap and patient-level permutation test; its own outputs are not touched.

Two datasets:
  * mimic: the 207 MIMIC-IV-ED demo visits of the paper (56 patients). CIs: bootstrap over
    patients (`ci95Patient`). Paired tests: patient-level paired permutation test (two-sided, as in
    analyze.py), Holm within each model, measure and task (factorial, notice, examples).
  * handbook: the 149 ESI v4 handbook cases (data/esi_handbook_cases.json). Every case is its own
    patient, so the same functions give a bootstrap over cases and a case-level test.
    The pre-registered tests (research/preregistration_handbook.md) are computed exactly as
    written there and reported apart from the exploratory ones.

Also: the hardware check (laptop against GPU), Gemma 3 27B against MedGemma 27B in every setup,
the 8-bit check, the baselines (logistic regression, gradient boosting, always ESI 2, rules only),
and the retrieval cache reproduction check.
"""

import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PAPER = ROOT / "research" / "results"
EXT = ROOT / "research" / "results_ext"
HANDBOOK = ROOT / "data" / "esi_handbook_cases.json"
OUT_JSON = EXT / "summary_ext.json"
OUT_MD = EXT / "summary_ext.md"
SEED, PERMUTATIONS, BOOT = A.SEED, A.PERMUTATIONS, A.BOOTSTRAP_SAMPLES
MIN_VALID = 142  # pre-registration section 7: fewer valid answers than this (95% of 149) = inconclusive

MODELS = ["qwen2.5:7b", "llama3.1:8b", "gemma3:12b", "gemma3:27b", "medgemma:27b"]

# Setup key: (rag, safety, guide, notice, examples). notice: on | off | neutral | caution.
def key(rag=False, safety=False, guide=False, notice="on", examples=0):
    return (rag, safety, guide, notice, examples)


LLM_ONLY, SAFETY, SAFETY_QUIET = key(), key(safety=True), key(safety=True, notice="off")
GUIDE, GUIDE_SAFETY = key(guide=True), key(guide=True, safety=True)
RAG, FULL = key(rag=True), key(rag=True, safety=True)
GUIDE_RAG, GUIDE_RAG_SAFETY = key(rag=True, guide=True), key(rag=True, guide=True, safety=True)
NEUTRAL, CAUTION = key(safety=True, notice="neutral"), key(safety=True, notice="caution")
EXAMPLES, EXAMPLES_QUIET = key(examples=20), key(examples=20, safety=True, notice="off")
NAMES = {
    LLM_ONLY: "LLM only", SAFETY: "+ safety", SAFETY_QUIET: "+ safety, no notice", GUIDE: "+ ESI guide",
    GUIDE_SAFETY: "+ ESI guide + safety", RAG: "+ RAG", FULL: "Full (RAG + safety)", GUIDE_RAG: "+ guide + RAG",
    GUIDE_RAG_SAFETY: "+ guide + RAG + safety", NEUTRAL: "+ safety, neutral notice", CAUTION: "+ safety, caution notice",
    EXAMPLES: "+ 20 similar patients", EXAMPLES_QUIET: "+ 20 similar patients + safety, no notice",
}
PAPER_SETUPS = [LLM_ONLY, SAFETY, SAFETY_QUIET, GUIDE, GUIDE_SAFETY, RAG, FULL]

TASK_COMPARISONS = {
    "factorial": [(RAG, GUIDE_RAG), (GUIDE, GUIDE_RAG), (LLM_ONLY, GUIDE_RAG), (GUIDE_RAG, GUIDE_RAG_SAFETY),
                  (FULL, GUIDE_RAG_SAFETY), (GUIDE_SAFETY, GUIDE_RAG_SAFETY)],
    "notice": [(SAFETY, NEUTRAL), (SAFETY, CAUTION), (SAFETY_QUIET, NEUTRAL), (SAFETY_QUIET, CAUTION),
               (LLM_ONLY, NEUTRAL), (LLM_ONLY, CAUTION)],
    "examples": [(LLM_ONLY, EXAMPLES), (EXAMPLES, EXAMPLES_QUIET)],
}
# The paper's comparisons (analyze.py COMPARISONS), repeated on the handbook as exploratory tests.
PAPER_COMPARISONS = [(LLM_ONLY, SAFETY), (LLM_ONLY, RAG), (LLM_ONLY, GUIDE), (RAG, GUIDE), (RAG, FULL), (SAFETY, FULL),
                     (GUIDE, GUIDE_SAFETY), (FULL, GUIDE_SAFETY), (LLM_ONLY, SAFETY_QUIET), (SAFETY, SAFETY_QUIET)]

TESTS = {
    "underTriage": lambda r: r["predictedEsi"] > r["groundTruthEsi"],
    "exact": lambda r: r["predictedEsi"] == r["groundTruthEsi"],
}


# ── loading ──────────────────────────────────────────────────────────────────

def load_datasets():
    mimic = A.load_cohort()
    handbook = {c["stayId"]: c for c in json.loads(HANDBOOK.read_text())["cases"]}
    return {"mimic": mimic, "handbook": handbook}


def setup_key(config):
    notice = config.get("safetyNoticeWording") or ("on" if config.get("safetyNotice", True) else "off")
    return key(config["useRag"], config["useSafety"], config.get("useGuide", False), notice, config.get("examples", 0))


def load_run(path, source, datasets):
    run = json.loads(path.read_text())
    if "results" not in run or "config" not in run:
        return None
    ds = "handbook" if run["config"]["dataset"].endswith("esi_handbook_cases.json") else "mimic"
    cohort = datasets[ds]
    for r in run["results"]:
        if cohort[r["stayId"]]["label"]["esi"] != r["groundTruthEsi"]:
            raise SystemExit(f"{path}: case {r['stayId']} label does not match {ds}")
    c = run["config"]
    return {
        "id": f"{ds}/{source}/{path.stem}",
        "file": str(path.relative_to(ROOT)),
        "dataset": ds,
        "source": source,
        "model": c["model"] or "rules-only",
        "setup": None if c["mode"] == "rules-only" else setup_key(c),
        "run": run,
    }


def load_all(datasets):
    runs = []
    for path in sorted(PAPER.glob("*.json")):
        r = load_run(path, "paper", datasets)
        if r:
            runs.append(r)
    for sub in ("hw", "factorial", "handbook", "notice", "examples", "precision"):
        for path in sorted((EXT / sub).glob("*.json")) if (EXT / sub).exists() else []:
            if path.name.startswith("retrieval_cache") or path.name == "neighbours.json":
                continue
            r = load_run(path, sub, datasets)
            if r:
                runs.append(r)
    return runs


def main_runs(runs, dataset):
    """(model, setup) -> run used in the main tables: on MIMIC the paper's run where there is one
    (laptop for the small models), otherwise the extension run; the hw and precision runs are separate."""
    out = {}
    for r in runs:
        if r["dataset"] != dataset or r["source"] in ("hw", "precision") or not r["run"]["complete"]:
            continue
        k = (r["model"], r["setup"])
        if k not in out or r["source"] == "paper":
            out[k] = r
    return out


# ── statistics ───────────────────────────────────────────────────────────────

def patient_weighted(rows, cohort, test):
    groups = defaultdict(list)
    for r in rows:
        groups[cohort[r["stayId"]]["subjectId"]].append(test(r))
    return sum(sum(g) / len(g) for g in groups.values()) / len(groups)


def summarise(r, datasets):
    cohort = datasets[r["dataset"]]
    s = A.summarise_run(r["run"], cohort)
    ok = [x for x in r["run"]["results"] if x["status"] == "ok"]
    s.update({"id": r["id"], "file": r["file"], "dataset": r["dataset"], "source": r["source"], "model": r["model"],
              "setup": NAMES.get(r["setup"], str(r["setup"])) if r["setup"] else "Rules only"})
    s.pop("config", None)
    if r["dataset"] == "mimic" and ok:
        s["patientWeighted"] = {name: patient_weighted(ok, cohort, t) for name, t in TESTS.items()}
    if r["dataset"] == "handbook" and ok:
        s["bySubgroup"] = {}
        for name, sel in (("practice", lambda c: c["source"]["set"].startswith("Chapter 9")),
                          ("competency", lambda c: c["source"]["set"].startswith("Chapter 10")),
                          ("paediatric", lambda c: c["paediatric"]), ("adult", lambda c: not c["paediatric"])):
            pairs = [(x["groundTruthEsi"], x["predictedEsi"]) for x in ok if sel(cohort[x["stayId"]])]
            if pairs:
                s["bySubgroup"][name] = {"n": len(pairs), "exact": A.exact(pairs), "underTriage": A.under(pairs)}
    return s


def shared_ok(run_a, run_b):
    a = {x["stayId"]: x for x in run_a["results"] if x["status"] == "ok"}
    b = {x["stayId"]: x for x in run_b["results"] if x["status"] == "ok"}
    shared = sorted(a.keys() & b.keys())
    return a, b, shared


def one_sided_permutation(d):
    """Case-level paired sign-flip test of H: sum(d) > 0, as in pre-registration section 6.

    d holds, per case, (run B minus run A) for the measure, signed so that the hypothesis
    predicts a positive value. p = (permuted sums >= observed + 1) / (permutations + 1).
    """
    d = [v for v in d if v != 0]
    observed = sum(d)
    if not d:
        return 1.0
    rng = random.Random(SEED)
    hits = sum(1 for _ in range(PERMUTATIONS) if sum(v if rng.random() < 0.5 else -v for v in d) >= observed)
    return (hits + 1) / (PERMUTATIONS + 1)


def bootstrap_diff(xa, xb, units):
    """95% percentile bootstrap CI of mean(xb) - mean(xa), resampling units with all their cases."""
    groups = defaultdict(list)
    for a, b, u in zip(xa, xb, units):
        groups[u].append(int(b) - int(a))
    clusters = list(groups.values())
    rng = random.Random(SEED)
    stats = []
    for _ in range(BOOT):
        sample = [v for _ in range(len(clusters)) for v in clusters[rng.randrange(len(clusters))]]
        stats.append(sum(sample) / len(sample))
    stats.sort()
    return [stats[int(0.025 * len(stats))], stats[min(len(stats) - 1, int(0.975 * len(stats)))]]


def compare(run_a, run_b, cohort, name_a, name_b, **extra):
    """Two-sided paired comparison on the cases valid in both runs; units are patients (cases on the handbook)."""
    a, b, shared = shared_ok(run_a, run_b)
    units = [cohort[s]["subjectId"] for s in shared]
    row = {"a": name_a, "b": name_b, "n": len(shared), "units": len(set(units)), **extra}
    for metric, test in TESTS.items():
        xa, xb = [test(a[s]) for s in shared], [test(b[s]) for s in shared]
        only_a, only_b, p_mcnemar = A.mcnemar_exact(xa, xb)
        row[metric] = {
            "a": sum(xa) / len(shared) if shared else None,
            "b": sum(xb) / len(shared) if shared else None,
            "diffCi95": bootstrap_diff(xa, xb, units) if shared else None,
            "onlyA": only_a, "onlyB": only_b, "pMcNemar": p_mcnemar,
            "p": A.paired_permutation_patient(xa, xb, units),
        }
    return row


def holm_family(rows, family_of):
    families = defaultdict(list)
    for row in rows:
        families[family_of(row)].append(row)
    for family in families.values():
        for metric in TESTS:
            for row, adj in zip(family, A.holm([r[metric]["p"] for r in family])):
                row[metric]["pHolm"] = adj
                row[metric]["holmFamilySize"] = len(family)


# ── analyses ─────────────────────────────────────────────────────────────────

def hardware_check(runs, datasets):
    cohort = datasets["mimic"]
    paper = {r["model"]: r for r in runs if r["dataset"] == "mimic" and r["source"] == "paper" and r["setup"] == LLM_ONLY}
    out = []
    for r in runs:
        if r["source"] != "hw":
            continue
        lap = paper[r["model"]]
        a, b, shared = shared_ok(lap["run"], r["run"])
        same = sum(a[s]["predictedEsi"] == b[s]["predictedEsi"] for s in shared)
        moves = Counter(f"{a[s]['predictedEsi']}->{b[s]['predictedEsi']}" for s in shared if a[s]["predictedEsi"] != b[s]["predictedEsi"])
        row = compare(lap["run"], r["run"], cohort, "laptop (Apple M4)", "GPU (H100 MIG 3g.40gb)", model=r["model"],
                      laptopFile=lap["file"], gpuFile=r["file"])
        row.update({
            "identicalEsi": same, "identicalEsiShare": same / len(shared),
            "identicalReasoningText": sum(a[s]["reasoning"] == b[s]["reasoning"] for s in shared),
            "changedAnswers": dict(moves),
            "meanLatencyMsLaptop": lap["run"]["results"] and round(sum(x["latencyMs"] for x in lap["run"]["results"]) / len(lap["run"]["results"])),
            "meanLatencyMsGpu": round(sum(x["latencyMs"] for x in r["run"]["results"]) / len(r["run"]["results"])),
        })
        out.append(row)
    return out


def mimic_extension_comparisons(runs, datasets):
    cohort = datasets["mimic"]
    main = main_runs(runs, "mimic")
    rows = []
    for model in sorted({m for m, _ in main}):
        for task, pairs in TASK_COMPARISONS.items():
            for ka, kb in pairs:
                if (model, ka) in main and (model, kb) in main:
                    rows.append(compare(main[(model, ka)]["run"], main[(model, kb)]["run"], cohort, NAMES[ka], NAMES[kb],
                                        model=model, task=task, fileA=main[(model, ka)]["file"], fileB=main[(model, kb)]["file"]))
    holm_family(rows, lambda r: (r["model"], r["task"]))
    return rows


def examples_vs_baseline(runs, datasets):
    """Exploratory: the similar-patients setup against the logistic regression, visit by visit."""
    pred_file = EXT / "baselines_predictions.json"
    if not pred_file.exists():
        return []
    preds = json.loads(pred_file.read_text())
    cohort = datasets["mimic"]
    main = main_runs(runs, "mimic")
    rows = []
    for name in ("Logistic regression", "Gradient boosting"):
        fake = {"results": [{"stayId": s, "groundTruthEsi": preds["labels"][s], "predictedEsi": p, "status": "ok"}
                            for s, p in preds["predictions"][name].items()]}
        for (model, setup), r in sorted(main.items()):
            if setup in (EXAMPLES, LLM_ONLY):
                rows.append(compare(fake, r["run"], cohort, name, f"{model} {NAMES[setup]}", model=model, baseline=name))
    holm_family(rows, lambda r: r["baseline"])
    return rows


def gemma_vs_medgemma(runs, datasets):
    rows = []
    for ds in ("mimic", "handbook"):
        main = main_runs(runs, ds)
        for setup in NAMES:
            if ("gemma3:27b", setup) in main and ("medgemma:27b", setup) in main:
                g, m = main[("gemma3:27b", setup)], main[("medgemma:27b", setup)]
                rows.append(compare(g["run"], m["run"], datasets[ds], "gemma3:27b", "medgemma:27b", dataset=ds,
                                    setup=NAMES[setup], fileA=g["file"], fileB=m["file"]))
    holm_family(rows, lambda r: r["dataset"])
    return rows


def precision_check(runs, datasets):
    cohort = datasets["mimic"]
    main = main_runs(runs, "mimic")
    rows = []
    for r in runs:
        if r["source"] != "precision":
            continue
        q4 = main.get(("gemma3:27b", r["setup"]))
        if not q4:
            continue
        a, b, shared = shared_ok(q4["run"], r["run"])
        row = compare(q4["run"], r["run"], cohort, "gemma3:27b Q4_K_M", f"{r['model']}", setup=NAMES[r["setup"]],
                      fileA=q4["file"], fileB=r["file"])
        row["identicalEsi"] = sum(a[s]["predictedEsi"] == b[s]["predictedEsi"] for s in shared)
        rows.append(row)
    holm_family(rows, lambda r: "precision")
    return rows


PREREG = [
    # id, family, model A, setup A, model B, setup B, measure, sign (+1: hypothesis B > A; -1: B < A), kind
    ("H1a", "H1", "qwen2.5:7b", SAFETY_QUIET, "qwen2.5:7b", SAFETY, "underTriage", +1, "effect"),
    ("H1b", "H1", "gemma3:27b", SAFETY_QUIET, "gemma3:27b", SAFETY, "underTriage", +1, "effect"),
    ("H1c", "H1", "medgemma:27b", SAFETY_QUIET, "medgemma:27b", SAFETY, "underTriage", +1, "effect"),
    ("H2a", "H2", "qwen2.5:7b", LLM_ONLY, "qwen2.5:7b", RAG, "underTriage", -1, "effect"),
    ("H2b", "H2", "llama3.1:8b", LLM_ONLY, "llama3.1:8b", RAG, "underTriage", -1, "effect"),
    ("H2c", "H2", "gemma3:12b", LLM_ONLY, "gemma3:12b", RAG, "underTriage", -1, "effect"),
    ("H3", "H3", "gemma3:12b", LLM_ONLY, "gemma3:12b", GUIDE, "exact", +1, "effect"),
    ("H4a", "H4", "gemma3:12b", LLM_ONLY, "gemma3:27b", LLM_ONLY, "exact", +1, "effect"),
    ("H4b", "H4", "gemma3:12b", LLM_ONLY, "medgemma:27b", LLM_ONLY, "exact", +1, "effect"),
    ("H4c", "H4c", "gemma3:27b", LLM_ONLY, "medgemma:27b", LLM_ONLY, "exact", +1, "absence"),
]


def preregistered(runs, datasets):
    """Pre-registered tests, exactly as in research/preregistration_handbook.md sections 4 to 7."""
    cohort = datasets["handbook"]
    by = {(r["model"], r["setup"]): r for r in runs if r["dataset"] == "handbook" and r["source"] == "handbook"}
    rows = []
    for hid, family, ma, sa, mb, sb, metric, sign, kind in PREREG:
        row = {"id": hid, "family": family, "measure": metric, "a": f"{ma} {NAMES[sa]}", "b": f"{mb} {NAMES[sb]}",
               "hypothesis": ("B higher than A" if sign > 0 else "B lower than A") + (" (absence: B not higher than A)" if kind == "absence" else "")}
        ra, rb = by.get((ma, sa)), by.get((mb, sb))
        problems = []
        for label, r in (("A", ra), ("B", rb)):
            if r is None:
                problems.append(f"run {label} missing")
            elif not r["run"]["complete"]:
                problems.append(f"run {label} not complete")
            elif r["run"]["counts"]["ok"] < MIN_VALID:
                problems.append(f"run {label} has {r['run']['counts']['ok']} valid answers (< {MIN_VALID})")
        if problems:
            row.update({"verdict": "inconclusive", "reason": "; ".join(problems)})
            rows.append(row)
            continue
        a, b, shared = shared_ok(ra["run"], rb["run"])
        test = TESTS[metric]
        xa, xb = [test(a[s]) for s in shared], [test(b[s]) for s in shared]
        d = [sign * (int(y) - int(x)) for x, y in zip(xa, xb)]
        row.update({
            "fileA": ra["file"], "fileB": rb["file"], "n": len(shared),
            "valueA": sum(xa) / len(shared), "valueB": sum(xb) / len(shared),
            "diffBminusA": (sum(xb) - sum(xa)) / len(shared), "diffCi95": bootstrap_diff(xa, xb, shared),
            "onlyA": sum(x and not y for x, y in zip(xa, xb)), "onlyB": sum(y and not x for x, y in zip(xa, xb)),
            "pOneSided": one_sided_permutation(d),
            "pTwoSidedExploratory": A.paired_permutation_patient(xa, xb, shared),
            "observedDirection": "as hypothesised" if sum(d) > 0 else ("none" if sum(d) == 0 else "opposite"),
        })
        rows.append(row)
    # Holm within H1, H2, H3, and H4a+H4b; H4c unadjusted (pre-registration section 6).
    for family in ("H1", "H2", "H3", "H4"):
        fam = [r for r in rows if r["family"] == family and "pOneSided" in r]
        for r, adj in zip(fam, A.holm([r["pOneSided"] for r in fam])):
            r["pHolm"] = adj
    for r in rows:
        if "pOneSided" not in r:
            continue
        if r["family"] == "H4c":
            r["verdict"] = "supported" if r["pOneSided"] >= 0.05 else "not supported"
        else:
            r["verdict"] = "supported" if r["pHolm"] < 0.05 else "not supported"
    families = {}
    for family in ("H1", "H2", "H3", "H4"):
        verdicts = [r["verdict"] for r in rows if r["family"] in ((family, "H4c") if family == "H4" else (family,))]
        if any(v == "inconclusive" for v in verdicts):
            families[family] = "inconclusive" if all(v == "inconclusive" for v in verdicts) else "partly inconclusive"
        elif all(v == "supported" for v in verdicts):
            families[family] = "supported"
        elif not any(v == "supported" for v in verdicts):
            families[family] = "not supported"
        else:
            families[family] = "partly supported"
    return {"tests": rows, "families": families, "minValid": MIN_VALID, "permutations": PERMUTATIONS, "seed": SEED}


def handbook_exploratory(runs, datasets):
    cohort = datasets["handbook"]
    main = main_runs(runs, "handbook")
    rules = next((r for r in runs if r["dataset"] == "handbook" and r["model"] == "rules-only"), None)
    rows = []
    pairs = PAPER_COMPARISONS + TASK_COMPARISONS["factorial"] + TASK_COMPARISONS["notice"]
    for model in sorted({m for m, s in main if s}):
        for ka, kb in pairs:
            if (model, ka) in main and (model, kb) in main:
                rows.append(compare(main[(model, ka)]["run"], main[(model, kb)]["run"], cohort, NAMES[ka], NAMES[kb],
                                    model=model, fileA=main[(model, ka)]["file"], fileB=main[(model, kb)]["file"]))
        if rules and (model, FULL) in main:
            rows.append(compare(rules["run"], main[(model, FULL)]["run"], cohort, "Rules only", NAMES[FULL], model=model,
                                fileA=rules["file"], fileB=main[(model, FULL)]["file"]))
    holm_family(rows, lambda r: r["model"])
    return rows


def handbook_baselines(runs, datasets):
    cohort = datasets["handbook"]
    always2 = {"config": {"run": "always-esi-2"}, "complete": True, "counts": {"total": len(cohort)},
               "results": [{"stayId": s, "groundTruthEsi": c["label"]["esi"], "predictedEsi": 2, "status": "ok", "latencyMs": 0,
                            "retrievalBackend": "none", "confidence": None} for s, c in cohort.items()]}
    out = {"Always ESI 2": A.summarise_run(always2, cohort)}
    out["Always ESI 2"].pop("config", None)
    rules = next((r for r in runs if r["dataset"] == "handbook" and r["model"] == "rules-only"), None)
    if rules:
        out["Rules only"] = summarise(rules, datasets)
    out["safetyRules"] = A.safety_analysis([rules["run"]]) if rules else None
    return out


def retrieval_caches():
    out = {}
    v2 = json.loads((ROOT / "research" / "retrieval_cache.v2.json").read_text())
    repro_file = EXT / "handbook" / "retrieval_cache_mimic_repro.json"
    if repro_file.exists():
        repro = json.loads(repro_file.read_text())
        same_set = same_order = 0
        overlap = []
        for sid, e in v2["entries"].items():
            a = [c["chunkId"] for c in e["citations"]]
            b = [c["chunkId"] for c in repro["entries"][sid]["citations"]]
            same_set += set(a) == set(b)
            same_order += a == b
            overlap.append(len(set(a) & set(b)))
        out["mimicReproduction"] = {
            "file": str(repro_file.relative_to(ROOT)), "meta": repro["meta"], "paperMeta": v2["meta"],
            "visits": len(v2["entries"]), "identicalTop5Set": same_set, "identicalTop5Order": same_order,
            "sharedPassagesOfTop5": dict(sorted(Counter(overlap).items())),
            "identicalQueries": sum(v2["entries"][s]["query"] == repro["entries"][s]["query"] for s in v2["entries"]),
        }
    hb = EXT / "handbook" / "retrieval_cache_handbook.json"
    if hb.exists():
        out["handbook"] = {"file": str(hb.relative_to(ROOT)), "meta": json.loads(hb.read_text())["meta"]}
    return out


def pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}"


def ptxt(p):
    return "n/a" if p is None else ("<0.001" if p < 0.001 else f"{p:.3f}")


def write_markdown(s):
    L = ["# Extension results", "", "Generated by `research/analyze_ext.py`. Do not edit by hand. Percentages on cases with a valid answer.", ""]
    L += ["## Pre-registered tests (handbook)", "", "| Test | A | B | Measure | A % | B % | n | p one-sided | p Holm | Verdict |", "|---|---|---|---|---|---|---|---|---|---|"]
    for r in s["handbook"]["preregistered"]["tests"]:
        L.append(f"| {r['id']} | {r['a']} | {r['b']} | {r['measure']} | {pct(r.get('valueA'))} | {pct(r.get('valueB'))} | {r.get('n', '-')} | "
                 f"{ptxt(r.get('pOneSided'))} | {ptxt(r.get('pHolm'))} | {r['verdict']}{' (' + r['reason'] + ')' if r.get('reason') else ''} |")
    L += ["", "Families: " + ", ".join(f"{k}: {v}" for k, v in s["handbook"]["preregistered"]["families"].items()), ""]
    for ds in ("mimic", "handbook"):
        L += [f"## Runs ({ds})", "", "| Run | ok/total | Exact % [95% CI] | Within 1 % | Under % [95% CI] | Over % | Severe under % | QWK | Sens % | Spec % | ECE |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in s["runs"]:
            if r["dataset"] != ds or not r["metrics"]:
                continue
            m = r["metrics"]
            ci = lambda k: f"{pct(m[k]['value'])} [{pct(m[k]['ci95Patient'][0])}, {pct(m[k]['ci95Patient'][1])}]" if m[k]["ci95Patient"] else pct(m[k]["value"])
            ece = r["calibration"]["ece"] if r["calibration"] else None
            L.append(f"| {r['id']} | {r['ok']}/{r['total']} | {ci('exact')} | {pct(m['withinOne']['value'])} | {ci('underTriage')} | "
                     f"{pct(m['overTriage']['value'])} | {pct(m['severeUnderTriage']['value'])} | {m['quadraticKappa']['value']:.2f} | "
                     f"{pct(m['highAcuitySensitivity']['value'])} | {pct(m['highAcuitySpecificity']['value'])} | {'n/a' if ece is None else f'{ece:.3f}'} |")
        L.append("")
    sections = [("Hardware check (laptop vs GPU, LLM only, MIMIC)", s["mimic"]["hardwareCheck"]),
                ("MIMIC extension comparisons", s["mimic"]["comparisons"]),
                ("Similar patients vs ML baselines (MIMIC, exploratory)", s["mimic"]["examplesVsBaselines"]),
                ("8-bit check (MIMIC)", s["mimic"]["precision"]),
                ("Gemma 3 27B vs MedGemma 27B", s["gemmaVsMedgemma"]),
                ("Handbook exploratory comparisons", s["handbook"]["exploratory"])]
    for title, rows in sections:
        L += [f"## {title}", "", "| Model / setup | A | B | n | Under A -> B | p | p Holm | Exact A -> B | p | p Holm |", "|---|---|---|---|---|---|---|---|---|---|"]
        for r in rows:
            u, e = r["underTriage"], r["exact"]
            label = r.get("model") or r.get("setup") or ""
            if "dataset" in r:
                label = f"{r['dataset']}: {r.get('setup')}"
            L.append(f"| {label} | {r['a']} | {r['b']} | {r['n']} | {pct(u['a'])} -> {pct(u['b'])} | {ptxt(u['p'])} | {ptxt(u.get('pHolm'))} | "
                     f"{pct(e['a'])} -> {pct(e['b'])} | {ptxt(e['p'])} | {ptxt(e.get('pHolm'))} |")
        L.append("")
    OUT_MD.write_text("\n".join(L) + "\n")


def main():
    datasets = load_datasets()
    runs = load_all(datasets)
    summary = {
        "generatedBy": "research/analyze_ext.py",
        "bootstrapSamples": BOOT, "permutations": PERMUTATIONS, "seed": SEED,
        "datasets": {"mimic": {"cases": len(datasets["mimic"]), "units": len({c["subjectId"] for c in datasets["mimic"].values()})},
                     "handbook": {"cases": len(datasets["handbook"]), "units": len(datasets["handbook"]),
                                  "esiCounts": dict(sorted(Counter(str(c["label"]["esi"]) for c in datasets["handbook"].values()).items()))}},
        "runs": [summarise(r, datasets) for r in runs if r["source"] != "paper"],
        "mimic": {
            "hardwareCheck": hardware_check(runs, datasets),
            "comparisons": mimic_extension_comparisons(runs, datasets),
            "examplesVsBaselines": examples_vs_baseline(runs, datasets),
            "precision": precision_check(runs, datasets),
            "baselines": json.loads((EXT / "baselines_subgroups.json").read_text())["ml"] if (EXT / "baselines_subgroups.json").exists() else None,
        },
        "handbook": {
            "preregistered": preregistered(runs, datasets),
            "exploratory": handbook_exploratory(runs, datasets),
            "baselines": handbook_baselines(runs, datasets),
        },
        "gemmaVsMedgemma": gemma_vs_medgemma(runs, datasets),
        "retrievalCaches": retrieval_caches(),
        "incompleteRuns": [r["id"] for r in runs if not r["run"]["complete"]],
    }
    # Results added by hand-run checks (prompt length, neighbours, human retrieval rating), if present.
    for name in ("prompt_tokens.json", "examples/neighbours_summary.json", "retrieval_human_check.json"):
        f = EXT / name
        if f.exists():
            summary[re.sub(r"\W", "_", f.stem)] = json.loads(f.read_text())
    OUT_JSON.write_text(json.dumps(summary, indent=2) + "\n")
    write_markdown(summary)
    print(f"Wrote {OUT_JSON.relative_to(ROOT)} and {OUT_MD.relative_to(ROOT)}: {len(summary['runs'])} new runs, "
          f"{len(summary['incompleteRuns'])} incomplete")


if __name__ == "__main__":
    main()
