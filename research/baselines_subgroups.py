"""Non-LLM baselines and subgroup results (no model runs needed).

    research/.venv-rerank/bin/python -I research/baselines_subgroups.py

Writes research/results/baselines_subgroups.json:

  * NEWS baseline: the National Early Warning Score (RCP 2012 bands, as validated by
    Smith et al. 2013) from the triage vital signs, used to flag high-priority
    patients (NEWS >= 5 counts as ESI 1-2). Level of consciousness and supplemental
    oxygen are not recorded at triage in MIMIC-IV-ED and score 0; missing vitals score 0.
  * Always ESI 2 (the most common nurse level), and machine-learning baselines predicting the ESI level from the same triage
    information the LLMs see (age, sex, arrival, vital signs, pain score, words of
    the chief complaint): multinomial logistic regression and gradient boosting.
    Predictions are out-of-fold from 5-fold cross-validation grouped by patient, so
    no patient is in both the training and the test folds.
  * Subgroups: under-triage and exact agreement by sex and age group for every
    complete run, with patient-level bootstrap CIs.

Metric definitions and the patient-level bootstrap are imported from analyze.py.
"""

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "research" / "results" / "baselines_subgroups.json"
VITALS = ["heartRate", "respiratoryRate", "oxygenSaturation", "systolicBp", "diastolicBp", "temperatureC"]
REPORT = ["exact", "withinOne", "underTriage", "overTriage", "severeUnderTriage", "quadraticKappa",
          "highAcuitySensitivity", "highAcuitySpecificity"]
AGE_GROUPS = [("18-44", 0, 44), ("45-64", 45, 64), ("65+", 65, 200)]


def band(x, bands):
    for upper, score in bands:
        if x <= upper:
            return score
    return bands[-1][1]


def news(v):
    """Aggregate NEWS (2012) from triage vitals; missing parameters score 0."""
    s = 0
    if v.get("respiratoryRate") is not None:
        s += band(v["respiratoryRate"], [(8, 3), (11, 1), (20, 0), (24, 2), (1e9, 3)])
    if v.get("oxygenSaturation") is not None:
        s += band(v["oxygenSaturation"], [(91, 3), (93, 2), (95, 1), (1e9, 0)])
    if v.get("temperatureC") is not None:
        s += band(v["temperatureC"], [(35.0, 3), (36.0, 1), (38.0, 0), (39.0, 1), (1e9, 2)])
    if v.get("systolicBp") is not None:
        s += band(v["systolicBp"], [(90, 3), (100, 2), (110, 1), (219, 0), (1e9, 3)])
    if v.get("heartRate") is not None:
        s += band(v["heartRate"], [(40, 3), (50, 1), (90, 0), (110, 1), (130, 2), (1e9, 3)])
    return s


def metrics(pairs, subjects):
    out = {}
    for name in REPORT:
        fn = A.METRICS[name]
        out[name] = {"value": fn(pairs), "ci95Patient": A.bootstrap_ci_patient(pairs, subjects, fn)}
    return out


def features(cases, vocab_fit=None):
    num, miss = [], []
    for c in cases:
        x = c["input"]
        v = x.get("vitals") or {}
        row = [x.get("age"), 1.0 if x.get("gender") == "MALE" else 0.0,
               1.0 if x.get("arrivalTransport") == "AMBULANCE" else 0.0,
               1.0 if x.get("arrivalTransport") == "WALK IN" else 0.0]
        row += [v.get(k) for k in VITALS] + [x.get("painScore")]
        num.append(row)
    num = np.array(num, dtype=float)
    miss = np.isnan(num).astype(float)
    return num, miss


def ml_baselines(cases):
    y = np.array([c["label"]["esi"] for c in cases])
    groups = np.array([c["subjectId"] for c in cases])
    text = [c["input"].get("chiefComplaint") or "" for c in cases]
    num, miss = features(cases)
    preds = {"Logistic regression": np.zeros_like(y), "Gradient boosting": np.zeros_like(y)}
    for train, test in GroupKFold(n_splits=5).split(num, y, groups):
        med = np.nanmedian(num[train], axis=0)
        filled = np.where(np.isnan(num), med, num)
        scaler = StandardScaler().fit(filled[train])
        vec = CountVectorizer(binary=True, min_df=2, token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z]+\b").fit([text[i] for i in train])
        words = vec.transform(text).toarray().astype(float)
        X = np.hstack([scaler.transform(filled), miss, words])
        lr = LogisticRegression(max_iter=5000, C=1.0).fit(X[train], y[train])
        preds["Logistic regression"][test] = lr.predict(X[test])
        Xg = np.hstack([num, words])  # gradient boosting handles missing values natively
        gb = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=3, random_state=A.SEED)
        preds["Gradient boosting"][test] = gb.fit(Xg[train], y[train]).predict(Xg[test])
    # The most common nurse level for everyone: the simplest rule that uses no patient data.
    preds["Always ESI 2"] = np.full_like(y, 2)
    subjects = list(groups)
    out = {}
    for name, p in preds.items():
        pairs = list(zip(y.tolist(), p.tolist()))
        out[name] = {"metrics": metrics(pairs, subjects), "predicted": {str(k): int((p == k).sum()) for k in A.LEVELS}}
    return out


def news_baseline(cases):
    subjects = [c["subjectId"] for c in cases]
    out = {}
    for threshold in (5, 7):
        flagged = [news(c["input"].get("vitals") or {}) >= threshold for c in cases]
        hi = [c["label"]["esi"] <= 2 for c in cases]
        # encode as ESI-like pairs so the analyze.py high-acuity metrics apply: flagged -> 2, not flagged -> 3
        pairs = [(c["label"]["esi"], 2 if f else 3) for c, f in zip(cases, flagged)]
        out[f"NEWS >= {threshold}"] = {
            "flagged": sum(flagged),
            "truePositives": sum(f and h for f, h in zip(flagged, hi)),
            "highAcuitySensitivity": {"value": A.high_acuity_sensitivity(pairs),
                                      "ci95Patient": A.bootstrap_ci_patient(pairs, subjects, A.high_acuity_sensitivity)},
            "highAcuitySpecificity": {"value": A.high_acuity_specificity(pairs),
                                      "ci95Patient": A.bootstrap_ci_patient(pairs, subjects, A.high_acuity_specificity)},
        }
    return out


def subgroups(runs, cohort):
    def group_of(c):
        x = c["input"]
        age = x.get("age")
        ag = next((g for g, lo, hi in AGE_GROUPS if age is not None and lo <= age <= hi), "unknown")
        return {"sex": "female" if x.get("gender") == "FEMALE" else "male", "age": ag}

    out = []
    for run in runs:
        if not run["complete"]:
            continue
        ok = [r for r in run["results"] if r["status"] == "ok"]
        row = {"run": run["config"]["run"], "groups": {}}
        for dim, values in (("sex", ["female", "male"]), ("age", [g for g, _, _ in AGE_GROUPS])):
            for val in values:
                sel = [r for r in ok if group_of(cohort[r["stayId"]])[dim] == val]
                pairs = [(r["groundTruthEsi"], r["predictedEsi"]) for r in sel]
                subs = [cohort[r["stayId"]]["subjectId"] for r in sel]
                if not pairs:
                    continue
                row["groups"][f"{dim}={val}"] = {
                    "visits": len(pairs), "patients": len(set(subs)),
                    "underTriage": {"value": A.under(pairs), "ci95Patient": A.bootstrap_ci_patient(pairs, subs, A.under)},
                    "exact": {"value": A.exact(pairs), "ci95Patient": A.bootstrap_ci_patient(pairs, subs, A.exact)},
                }
        out.append(row)
    return out


def main():
    cohort = A.load_cohort()
    cases = list(cohort.values())
    result = {
        "visits": len(cases),
        "patients": len({c["subjectId"] for c in cases}),
        "news": news_baseline(cases),
        "ml": ml_baselines(cases),
        "subgroups": subgroups(A.load_runs(), cohort),
    }
    OUT.write_text(json.dumps(result, indent=2) + "\n")

    f = lambda m: f"{100 * m['value']:.1f} ({100 * m['ci95Patient'][0]:.1f}-{100 * m['ci95Patient'][1]:.1f})"
    for name, r in result["ml"].items():
        m = r["metrics"]
        print(f"{name:20s} exact {f(m['exact'])}  under {f(m['underTriage'])}  QWK {m['quadraticKappa']['value']:.2f}  "
              f"sens {f(m['highAcuitySensitivity'])}  spec {f(m['highAcuitySpecificity'])}  predicted {r['predicted']}")
    for name, r in result["news"].items():
        print(f"{name:20s} flagged {r['flagged']}  sens {f(r['highAcuitySensitivity'])}  spec {f(r['highAcuitySpecificity'])}")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
