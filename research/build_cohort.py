"""Build the evaluation cohort from the MIMIC-IV-ED demo (v2.2, open access, ODbL).

Run from the repo root:  python3 -I research/build_cohort.py

Leakage rules:
  * `input` holds only what a triage nurse knows at triage time: age, sex,
    arrival mode, chief complaint, triage vitals and pain score.
  * `label` holds the triage nurse's ESI (`acuity`), the reference standard.
  * `outcome` holds post-triage information (disposition, ED discharge
    diagnoses). It is for error analysis only and must never reach the model.

Inclusion: every ED stay in triage.csv with a recorded acuity. Missing triage
vitals stay missing (no imputation from later vitalsign rows, which would leak
post-triage information). Physiologically implausible values are set to
missing using the ranges below; the script reports every value it drops.
Non-numeric pain entries ("unable", "Critical", "ett") are dropped: some may
encode the nurse's acuity judgement, which would leak the label.
"""

import csv
import gzip
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ED_DIR = ROOT / "data" / "mimic-iv-ed"
PATIENTS = ROOT / "data" / "mimic-iv-demo" / "hosp" / "patients.csv.gz"
OUT = ROOT / "data" / "mimic_ed_cohort.json"

# Plausible ranges; values outside are treated as recording errors.
RANGES = {
    "temperatureF": (90, 110),
    "heartRate": (20, 250),
    "respiratoryRate": (4, 60),
    "oxygenSaturation": (50, 100),
    "systolicBp": (50, 300),
    "diastolicBp": (20, 200),
}
TRIAGE_FIELDS = {
    "temperatureF": "temperature",
    "heartRate": "heartrate",
    "respiratoryRate": "resprate",
    "oxygenSaturation": "o2sat",
    "systolicBp": "sbp",
    "diastolicBp": "dbp",
}


def read_csv(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", newline="") as f:
        return list(csv.DictReader(f))


def parse_number(raw):
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def main():
    triage = read_csv(ED_DIR / "triage.csv")
    stays = {r["stay_id"]: r for r in read_csv(ED_DIR / "edstays.csv")}
    patients = {r["subject_id"]: r for r in read_csv(PATIENTS)}
    diagnoses = {}
    for r in read_csv(ED_DIR / "diagnosis.csv"):
        diagnoses.setdefault(r["stay_id"], []).append((int(r["seq_num"]), r["icd_title"]))

    dropped = []
    excluded = Counter()
    cases = []

    for t in triage:
        acuity = parse_number(t["acuity"])
        if acuity is None:
            excluded["missing acuity"] += 1
            continue
        stay = stays[t["stay_id"]]
        patient = patients[t["subject_id"]]

        intime = datetime.strptime(stay["intime"], "%Y-%m-%d %H:%M:%S")
        age = int(patient["anchor_age"]) + (intime.year - int(patient["anchor_year"]))

        vitals = {}
        for key, column in TRIAGE_FIELDS.items():
            value = parse_number(t[column])
            if value is None:
                continue
            if key == "temperatureF" and 30 <= value <= 45:
                value = value * 9 / 5 + 32  # recorded in Celsius
            low, high = RANGES[key]
            if not low <= value <= high:
                dropped.append((t["stay_id"], column, t[column]))
                continue
            vitals[key] = value
        if "temperatureF" in vitals:
            vitals["temperatureC"] = round((vitals.pop("temperatureF") - 32) * 5 / 9, 1)
        for key in ("heartRate", "respiratoryRate", "oxygenSaturation", "systolicBp", "diastolicBp"):
            if key in vitals:
                vitals[key] = int(round(vitals[key]))

        pain = parse_number(t["pain"])
        if t["pain"] and (pain is None or not 0 <= pain <= 10 or pain != int(pain)):
            dropped.append((t["stay_id"], "pain", t["pain"]))
            pain = None

        cases.append(
            {
                "stayId": t["stay_id"],
                "subjectId": t["subject_id"],
                "input": {
                    "age": age,
                    "gender": {"F": "FEMALE", "M": "MALE"}.get(stay["gender"], "OTHER"),
                    "arrivalTransport": stay["arrival_transport"],
                    "chiefComplaint": t["chiefcomplaint"].strip(),
                    "vitals": vitals,
                    "painScore": int(pain) if pain is not None else None,
                },
                "label": {"esi": int(acuity)},
                "outcome": {
                    "disposition": stay["disposition"],
                    "dischargeDiagnoses": [title for _, title in sorted(diagnoses.get(t["stay_id"], []))],
                },
            }
        )

    cases.sort(key=lambda c: c["stayId"])
    esi_counts = Counter(c["label"]["esi"] for c in cases)
    missing_vitals = sum(1 for c in cases if not c["input"]["vitals"])

    OUT.write_text(
        json.dumps(
            {
                "meta": {
                    "source": "MIMIC-IV-ED Demo v2.2 + MIMIC-IV Demo v2.2 (patients), PhysioNet, ODbL 1.0",
                    "generatedBy": "research/build_cohort.py",
                    "inclusion": "ED stays in triage.csv with a recorded acuity",
                    "excluded": dict(excluded),
                    "n": len(cases),
                    "esiCounts": {str(k): v for k, v in sorted(esi_counts.items())},
                    "casesWithNoTriageVitals": missing_vitals,
                    "droppedImplausibleValues": [
                        {"stayId": s, "field": f, "raw": v} for s, f, v in dropped
                    ],
                },
                "cases": cases,
            },
            indent=2,
        )
        + "\n"
    )

    print(f"Wrote {OUT.relative_to(ROOT)}: {len(cases)} cases")
    print(f"  ESI distribution: {dict(sorted(esi_counts.items()))}")
    print(f"  Excluded: {dict(excluded)}")
    print(f"  Cases with no triage vitals: {missing_vitals}")
    print(f"  Implausible values set to missing: {len(dropped)}")
    for s, f, v in dropped:
        print(f"    stay {s}: {f}={v!r}")


if __name__ == "__main__":
    main()
