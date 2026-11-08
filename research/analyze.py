"""Statistics for the ablation runs. Standard library only.

Run from the repo root:  python3 -I research/analyze.py

Reads research/results/*.json (one file per run, written by
apps/server/scripts/evaluate_mimic.ts) and writes research/results/summary.json
and research/results/summary.md.

  * Headline metrics use cases with status "ok" (a valid model output).
    Fallback and error cases are counted per run, never dropped silently.
  * 95% confidence intervals: percentile bootstrap over cases.
  * Paired comparisons: exact McNemar test on cases that are "ok" in both runs,
    with Holm-adjusted p values within each model and metric (pre-specified and
    exploratory comparisons are separate families).
  * Under-triage = predicted ESI number higher (less urgent) than the reference.
  * High-acuity detection treats ESI 1-2 as positive and ESI 3-5 as negative.
  * Calibration: expected calibration error of the model's self-reported
    confidence against exact-match correctness (10 equal-width bins).
"""

import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "research" / "results"
COHORT = ROOT / "data" / "mimic_ed_cohort.json"
BOOTSTRAP_SAMPLES = 2000
SEED = 42
LEVELS = [1, 2, 3, 4, 5]

# Condition key: (useRag, useSafety, useGuide, safetyNotice).
LLM_ONLY, SAFETY = (False, False, False, True), (False, True, False, True)
GUIDE, GUIDE_SAFETY = (False, False, True, True), (False, True, True, True)
RAG, FULL = (True, False, False, True), (True, True, False, True)
# Exploratory, added after the first qwen runs: safety on, but no "no red flags" notice when no rule fires.
SAFETY_QUIET = (False, True, False, False)
CONDITION_NAMES = {
    LLM_ONLY: "LLM only",
    SAFETY: "LLM + safety",
    GUIDE: "LLM + ESI guide",
    GUIDE_SAFETY: "LLM + ESI guide + safety",
    RAG: "LLM + RAG",
    FULL: "Full (LLM + RAG + safety)",
    SAFETY_QUIET: "LLM + safety, no negative notice (exploratory)",
}
COMPARISONS = [
    (LLM_ONLY, SAFETY),
    (LLM_ONLY, RAG),
    (LLM_ONLY, GUIDE),
    (RAG, GUIDE),
    (RAG, FULL),
    (SAFETY, FULL),
    (GUIDE, GUIDE_SAFETY),
    (FULL, GUIDE_SAFETY),
    (LLM_ONLY, SAFETY_QUIET),
    (SAFETY, SAFETY_QUIET),
]


def condition_key(config):
    return (config["useRag"], config["useSafety"], config.get("useGuide", False), config.get("safetyNotice", True))


# ── metrics ──────────────────────────────────────────────────────────────────

def exact(pairs):
    return sum(p == t for t, p in pairs) / len(pairs)


def within_one(pairs):
    return sum(abs(p - t) <= 1 for t, p in pairs) / len(pairs)


def under(pairs):
    return sum(p > t for t, p in pairs) / len(pairs)


def over(pairs):
    return sum(p < t for t, p in pairs) / len(pairs)


def quadratic_kappa(pairs):
    """Quadratic-weighted Cohen's kappa over ESI levels 1-5."""
    n, k = len(pairs), len(LEVELS)
    observed = [[0] * k for _ in range(k)]
    for t, p in pairs:
        observed[t - 1][p - 1] += 1
    row = [sum(r) for r in observed]
    col = [sum(observed[i][j] for i in range(k)) for j in range(k)]
    num = den = 0.0
    for i in range(k):
        for j in range(k):
            w = (i - j) ** 2 / (k - 1) ** 2
            num += w * observed[i][j]
            den += w * row[i] * col[j] / n
    return None if den == 0 else 1 - num / den


def severe_under(pairs):
    return sum(p - t >= 2 for t, p in pairs) / len(pairs)


def _share(pairs, condition, outcome):
    pool = [(t, p) for t, p in pairs if condition(t, p)]
    return sum(outcome(t, p) for t, p in pool) / len(pool) if pool else None


def high_acuity_sensitivity(pairs):
    return _share(pairs, lambda t, p: t <= 2, lambda t, p: p <= 2)


def high_acuity_specificity(pairs):
    return _share(pairs, lambda t, p: t >= 3, lambda t, p: p >= 3)


def high_acuity_ppv(pairs):
    return _share(pairs, lambda t, p: p <= 2, lambda t, p: t <= 2)


def high_acuity_npv(pairs):
    return _share(pairs, lambda t, p: p >= 3, lambda t, p: t >= 3)


METRICS = {
    "exact": exact,
    "withinOne": within_one,
    "underTriage": under,
    "overTriage": over,
    "quadraticKappa": quadratic_kappa,
    "severeUnderTriage": severe_under,
    "highAcuitySensitivity": high_acuity_sensitivity,
    "highAcuitySpecificity": high_acuity_specificity,
    "highAcuityPPV": high_acuity_ppv,
    "highAcuityNPV": high_acuity_npv,
}


def expected_calibration_error(records, bins=10):
    """ECE of self-reported confidence against exact-match correctness."""
    pts = [(r["confidence"], r["predictedEsi"] == r["groundTruthEsi"]) for r in records if r.get("confidence") is not None]
    if not pts:
        return None
    total = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        in_bin = [(c, ok) for c, ok in pts if lo <= c < hi or (b == bins - 1 and c == 1.0)]
        if in_bin:
            conf = sum(c for c, _ in in_bin) / len(in_bin)
            acc = sum(ok for _, ok in in_bin) / len(in_bin)
            total += len(in_bin) / len(pts) * abs(conf - acc)
    return {
        "ece": total,
        "meanConfidence": sum(c for c, _ in pts) / len(pts),
        "accuracy": sum(ok for _, ok in pts) / len(pts),
        "n": len(pts),
    }


def bootstrap_ci(pairs, fn):
    rng = random.Random(SEED)
    n = len(pairs)
    stats = []
    for _ in range(BOOTSTRAP_SAMPLES):
        value = fn([pairs[rng.randrange(n)] for _ in range(n)])
        if value is not None:
            stats.append(value)
    if not stats:
        return None
    stats.sort()
    return [stats[int(0.025 * len(stats))], stats[min(len(stats) - 1, int(0.975 * len(stats)))]]


def mcnemar_exact(a, b):
    """Two-sided exact McNemar test on paired binary outcomes."""
    only_a = sum(x and not y for x, y in zip(a, b))
    only_b = sum(y and not x for x, y in zip(a, b))
    n = only_a + only_b
    if n == 0:
        return only_a, only_b, 1.0
    tail = sum(math.comb(n, i) for i in range(min(only_a, only_b) + 1)) / 2**n
    return only_a, only_b, min(1.0, 2 * tail)


# ── loading ──────────────────────────────────────────────────────────────────

def load_cohort():
    return {c["stayId"]: c for c in json.loads(COHORT.read_text())["cases"]}


def load_runs():
    labels = {sid: c["label"]["esi"] for sid, c in load_cohort().items()}
    runs = []
    for path in sorted(RESULTS.glob("*.json")):
        if path.name in ("summary.json", "failure_examples.json"):
            continue
        run = json.loads(path.read_text())
        for r in run["results"]:
            if labels.get(r["stayId"]) != r["groundTruthEsi"]:
                raise SystemExit(f"{path.name}: stay {r['stayId']} label does not match the cohort file")
        runs.append(run)
    return runs


def ok_pairs(run):
    return [(r["groundTruthEsi"], r["predictedEsi"]) for r in run["results"] if r["status"] == "ok"]


# ── analyses ─────────────────────────────────────────────────────────────────

def summarise_run(run, cohort):
    results = run["results"]
    pairs = ok_pairs(run)
    ok = [r for r in results if r["status"] == "ok"]
    admitted = [r for r in ok if cohort[r["stayId"]]["outcome"]["disposition"] == "ADMITTED"]
    status = Counter(r["status"] for r in results)
    out = {
        "run": run["config"]["run"],
        "config": run["config"],
        "complete": run["complete"],
        "total": run["counts"]["total"],
        "done": len(results),
        "ok": status["ok"],
        "fallback": status["fallback"],
        "error": status["error"],
        "meanLatencyMs": round(sum(r["latencyMs"] for r in results) / len(results)) if results else None,
        "retrievalBackends": dict(Counter(r["retrievalBackend"] for r in results)),
        "metrics": {},
        "perLevel": {},
        "admitted": {
            "n": len(admitted),
            "underTriage": sum(r["predictedEsi"] > r["groundTruthEsi"] for r in admitted) / len(admitted) if admitted else None,
            "missedHighAcuity": sum(r["groundTruthEsi"] <= 2 and r["predictedEsi"] >= 3 for r in admitted),
        },
        "calibration": expected_calibration_error(ok),
    }
    if not pairs:
        return out
    for name, fn in METRICS.items():
        out["metrics"][name] = {"value": fn(pairs), "ci95": bootstrap_ci(pairs, fn)}
    for level in LEVELS:
        lp = [(t, p) for t, p in pairs if t == level]
        if lp:
            out["perLevel"][str(level)] = {"n": len(lp), "exact": exact(lp), "underTriage": under(lp)}
    return out


def paired_comparisons(runs):
    by_model = defaultdict(dict)
    rules = None
    for run in runs:
        c = run["config"]
        if c["mode"] == "rules-only":
            rules = run
        else:
            by_model[c["model"]][condition_key(c)] = run

    def compare(model, name_a, run_a, name_b, run_b):
        a = {r["stayId"]: r for r in run_a["results"] if r["status"] == "ok"}
        b = {r["stayId"]: r for r in run_b["results"] if r["status"] == "ok"}
        shared = sorted(a.keys() & b.keys())
        row = {"model": model, "a": name_a, "b": name_b, "n": len(shared)}
        for metric, test in (("underTriage", lambda r: r["predictedEsi"] > r["groundTruthEsi"]),
                             ("exact", lambda r: r["predictedEsi"] == r["groundTruthEsi"])):
            xa = [test(a[s]) for s in shared]
            xb = [test(b[s]) for s in shared]
            only_a, only_b, p = mcnemar_exact(xa, xb)
            row[metric] = {
                "a": sum(xa) / len(shared) if shared else None,
                "b": sum(xb) / len(shared) if shared else None,
                "onlyA": only_a,
                "onlyB": only_b,
                "p": p,
            }
        return row

    rows = []
    for model, conds in sorted(by_model.items()):
        for ka, kb in COMPARISONS:
            if ka in conds and kb in conds:
                row = compare(model, CONDITION_NAMES[ka], conds[ka], CONDITION_NAMES[kb], conds[kb])
                row["exploratory"] = SAFETY_QUIET in (ka, kb)
                rows.append(row)
        if rules and FULL in conds:
            row = compare(model, "Rules only", rules, CONDITION_NAMES[FULL], conds[FULL])
            row["exploratory"] = False
            rows.append(row)

    families = defaultdict(list)
    for row in rows:
        families[(row["model"], row["exploratory"])].append(row)
    for family in families.values():
        for metric in ("underTriage", "exact"):
            for row, adjusted in zip(family, holm([r[metric]["p"] for r in family])):
                row[metric]["pHolm"] = adjusted
    return rows


def holm(pvalues):
    """Holm step-down adjusted p values, in the input order."""
    m = len(pvalues)
    order = sorted(range(m), key=lambda i: pvalues[i])
    adjusted, running = [0.0] * m, 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * pvalues[i]))
        adjusted[i] = running
    return adjusted


def safety_analysis(runs):
    """How often each rule fires and how often the patient is truly high-acuity."""
    if not runs:
        return None
    # Safety fields are computed identically in every run; prefer the rules-only run.
    source = next((r for r in runs if r["config"]["mode"] == "rules-only"), runs[0])
    recs = source["results"]
    fired = [r for r in recs if r["safetyTriggered"]]
    esi1 = [r for r in recs if r["groundTruthEsi"] == 1]

    per_rule = {}
    for rule in sorted({x for r in fired for x in r["safetyRules"]}):
        hits = [r for r in fired if rule in r["safetyRules"]]
        per_rule[rule] = {
            "fired": len(hits),
            "trueEsi": dict(sorted(Counter(r["groundTruthEsi"] for r in hits).items())),
            "precisionEsi1": sum(r["groundTruthEsi"] == 1 for r in hits) / len(hits),
            "precisionEsi1or2": sum(r["groundTruthEsi"] <= 2 for r in hits) / len(hits),
        }
    return {
        "cases": len(recs),
        "fired": len(fired),
        "precisionEsi1": sum(r["groundTruthEsi"] == 1 for r in fired) / len(fired) if fired else None,
        "precisionEsi1or2": sum(r["groundTruthEsi"] <= 2 for r in fired) / len(fired) if fired else None,
        "sensitivityEsi1": sum(r["safetyTriggered"] for r in esi1) / len(esi1) if esi1 else None,
        "perRule": per_rule,
    }


def override_analysis(runs):
    """In safety-on LLM runs: what the forced ESI-1 overrides changed."""
    rows = []
    for run in runs:
        c = run["config"]
        if c["mode"] != "llm" or not c["useSafety"]:
            continue
        ok = [r for r in run["results"] if r["status"] == "ok"]
        overridden = [r for r in ok if r["safetyOverridden"]]
        rows.append({
            "run": c["run"],
            "okCases": len(ok),
            "overrides": len(overridden),
            "correctedUnderTriage": sum(r["modelEsi"] > r["groundTruthEsi"] for r in overridden),
            "nowExact": sum(r["groundTruthEsi"] == 1 for r in overridden),
            "nowOverTriaged": sum(r["groundTruthEsi"] > 1 for r in overridden),
            "modelEsiBeforeOverride": dict(sorted(Counter(r["modelEsi"] for r in overridden).items())),
        })
    return rows


# ── output ───────────────────────────────────────────────────────────────────

def pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}"


def metric_cell(m, as_pct=True):
    if not m:
        return "n/a"
    fmt = pct if as_pct else (lambda v: "n/a" if v is None else f"{v:.2f}")
    ci = m["ci95"]
    return f"{fmt(m['value'])} [{fmt(ci[0])}, {fmt(ci[1])}]" if ci else fmt(m["value"])


def pvalue(p):
    return "<0.001" if p < 0.001 else f"{p:.3f}"


def write_markdown(summary):
    lines = [
        "# Ablation results",
        "",
        "Generated by `research/analyze.py`. Do not edit by hand.",
        "Metrics on cases with valid model output (status ok); 95% bootstrap CIs in brackets.",
        "",
        "## Main results",
        "",
        "| Run | ok / total | fallback | error | Exact % | Within-1 % | Under-triage % | Over-triage % | QWK |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in summary["runs"]:
        m = r["metrics"]
        name = r["run"] + ("" if r["complete"] else f" (incomplete {r['done']}/{r['total']})")
        lines.append(
            f"| {name} | {r['ok']} / {r['total']} | {r['fallback']} | {r['error']} | "
            f"{metric_cell(m.get('exact'))} | {metric_cell(m.get('withinOne'))} | "
            f"{metric_cell(m.get('underTriage'))} | {metric_cell(m.get('overTriage'))} | "
            f"{metric_cell(m.get('quadraticKappa'), as_pct=False)} |"
        )

    lines += [
        "",
        "## High-acuity detection (ESI 1-2 vs 3-5) and clinically relevant errors",
        "",
        "| Run | Sensitivity % | Specificity % | PPV % | NPV % | Severe under-triage (≥2 levels) % | Under-triage among admitted % (n) | Admitted high-acuity missed | ECE |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in summary["runs"]:
        m, a, cal = r["metrics"], r["admitted"], r["calibration"]
        ece = "n/a" if not cal else f"{cal['ece']:.3f}"
        lines.append(
            f"| {r['run']} | {metric_cell(m.get('highAcuitySensitivity'))} | {metric_cell(m.get('highAcuitySpecificity'))} | "
            f"{metric_cell(m.get('highAcuityPPV'))} | {metric_cell(m.get('highAcuityNPV'))} | "
            f"{metric_cell(m.get('severeUnderTriage'))} | {pct(a['underTriage'])} ({a['n']}) | {a['missedHighAcuity']} | "
            f"{ece} |"
        )

    lines += ["", "## By reference ESI level (exact % / under-triage %)", ""]
    lines += ["| Run | " + " | ".join(f"ESI {l}" for l in LEVELS) + " |", "|---|" + "---|" * len(LEVELS)]
    for r in summary["runs"]:
        cells = []
        for l in LEVELS:
            v = r["perLevel"].get(str(l))
            cells.append(f"{pct(v['exact'])} / {pct(v['underTriage'])} (n={v['n']})" if v else "-")
        lines.append(f"| {r['run']} | " + " | ".join(cells) + " |")

    if summary["comparisons"]:
        lines += [
            "",
            "## Paired comparisons (exact McNemar)",
            "",
            "p (Holm): adjusted within each model and metric; exploratory comparisons form their own family.",
            "",
            "| Model | A | B | n | Under-triage A → B | p | p (Holm) | Exact A → B | p | p (Holm) |",
            "|---|---|---|---|---|---|---|---|---|---|",
        ]
        for c in summary["comparisons"]:
            u, e = c["underTriage"], c["exact"]
            lines.append(
                f"| {c['model'] or '-'} | {c['a']} | {c['b']} | {c['n']} | "
                f"{pct(u['a'])} → {pct(u['b'])} | {pvalue(u['p'])} | {pvalue(u['pHolm'])} | "
                f"{pct(e['a'])} → {pct(e['b'])} | {pvalue(e['p'])} | {pvalue(e['pHolm'])} |"
            )

    s = summary["safety"]
    if s:
        lines += [
            "",
            "## Safety rules",
            "",
            f"Fired on {s['fired']} of {s['cases']} cases. "
            f"Precision for ESI 1: {pct(s['precisionEsi1'])}%; for ESI 1-2: {pct(s['precisionEsi1or2'])}%. "
            f"Sensitivity for ESI 1: {pct(s['sensitivityEsi1'])}%.",
            "",
            "| Rule | Fired | Reference ESI counts | Precision ESI 1 % | Precision ESI 1-2 % |",
            "|---|---|---|---|---|",
        ]
        for rule, v in s["perRule"].items():
            lines.append(
                f"| {rule} | {v['fired']} | {v['trueEsi']} | {pct(v['precisionEsi1'])} | {pct(v['precisionEsi1or2'])} |"
            )

    if summary["overrides"]:
        lines += [
            "",
            "## Safety overrides in LLM runs",
            "",
            "| Run | ok cases | Overrides | Fixed under-triage | Now exact | Now over-triaged | Model ESI before override |",
            "|---|---|---|---|---|---|---|",
        ]
        for o in summary["overrides"]:
            lines.append(
                f"| {o['run']} | {o['okCases']} | {o['overrides']} | {o['correctedUnderTriage']} | "
                f"{o['nowExact']} | {o['nowOverTriaged']} | {o['modelEsiBeforeOverride']} |"
            )

    (RESULTS / "summary.md").write_text("\n".join(lines) + "\n")


def main():
    runs = load_runs()
    if not runs:
        raise SystemExit(f"No run files in {RESULTS.relative_to(ROOT)}")
    cohort = load_cohort()
    summary = {
        "bootstrapSamples": BOOTSTRAP_SAMPLES,
        "seed": SEED,
        "runs": [summarise_run(r, cohort) for r in runs],
        "comparisons": paired_comparisons(runs),
        "safety": safety_analysis(runs),
        "overrides": override_analysis(runs),
    }
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    write_markdown(summary)
    print(f"Wrote {(RESULTS / 'summary.md').relative_to(ROOT)} and summary.json ({len(runs)} runs)")


if __name__ == "__main__":
    main()
