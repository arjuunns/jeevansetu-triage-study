"""Blinded evaluation of retrieval quality (no ESI labels involved).

Run from the repo root:
  python3 -I research/retrieval_eval.py make    # writes research/retrieval_eval/rate.html
  (open rate.html in a browser, rate every passage, click "Download ratings")
  python3 -I research/retrieval_eval.py score [path/to/ratings.json]
  python3 -I research/retrieval_eval.py check   # rate_check.html: 50 random passages for a second rater
  python3 -I research/retrieval_eval.py agree [path/to/ratings_check.json]   # agreement with ratings.json

ratings.json holds the main ratings (made blind by an LLM judge, see
research/README.md); `check` and `agree` measure a human rater's agreement
with them on a random subset.

`make` samples 30 cohort cases, pools the top-5 passages from the baseline
retrieval (research/retrieval_cache_baseline.json: dense only, raw complaint
query) and the improved retrieval (research/retrieval_cache.json), shuffles
them and hides which system found which. `score` reports precision@5,
strict precision@5, mean graded relevance and nDCG@5 per system, with
bootstrap CIs and an exact sign test on per-case precision@5.
"""

import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "research" / "retrieval_eval"
COHORT = ROOT / "data" / "mimic_ed_cohort.json"
CORPUS = ROOT / "medical-pdf" / "ingestion" / "index" / "guidelines.metadata.jsonl"
SYSTEMS = {
    "baseline": ROOT / "research" / "retrieval_cache_baseline.json",
    "improved": ROOT / "research" / "retrieval_cache.json",
}
N_CASES = 30
SEED = 2026
N_CHECK = 50


def patient_summary(inp):
    v = inp["vitals"]
    vitals = ", ".join(
        f"{label} {v[key]}{unit}"
        for key, label, unit in [
            ("heartRate", "HR", ""),
            ("respiratoryRate", "RR", ""),
            ("oxygenSaturation", "SpO2", "%"),
            ("systolicBp", "SBP", ""),
            ("diastolicBp", "DBP", ""),
            ("temperatureC", "Temp", " C"),
        ]
        if key in v
    )
    pain = f"; pain {inp['painScore']}/10" if inp["painScore"] is not None else ""
    return (
        f"{inp['age']}-year-old {inp['gender'].lower()}, arrived by {inp['arrivalTransport'].lower()}. "
        f"Chief complaint: {inp['chiefComplaint']}. Vitals: {vitals or 'not recorded'}{pain}."
    )


def build():
    """Blinded cases (for the rating page) and the unblinded pool (for scoring). Deterministic."""
    cohort = {c["stayId"]: c for c in json.loads(COHORT.read_text())["cases"]}
    caches = {name: json.loads(path.read_text())["entries"] for name, path in SYSTEMS.items()}
    corpus = {}
    for line in CORPUS.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            corpus[row["id"]] = row
    rng = random.Random(SEED)
    stay_ids = rng.sample(sorted(cohort), N_CASES)

    cases, pool = [], []
    for i, sid in enumerate(stay_ids):
        ranks = {}
        texts = {}
        for name, entries in caches.items():
            for rank, cit in enumerate(entries[sid]["citations"], 1):
                ranks.setdefault(cit["chunkId"], {})[name] = rank
                row = corpus.get(cit["chunkId"])
                texts[cit["chunkId"]] = (cit["source"], row["content"] if row else cit["snippet"])
        chunk_ids = sorted(ranks)
        rng.shuffle(chunk_ids)
        passages, pooled = [], []
        for j, cid in enumerate(chunk_ids):
            key = f"c{i + 1}-p{j + 1}"
            source, text = texts[cid]
            passages.append({"key": key, "source": source, "text": text})
            pooled.append({"key": key, "chunkId": cid, **{f"{n}Rank": ranks[cid].get(n) for n in SYSTEMS}})
        cases.append({"patient": patient_summary(cohort[sid]["input"]), "passages": passages})
        pool.append({"stayId": sid, "passages": pooled})
    return cases, pool


def make():
    cases, pool = build()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "pool.json").write_text(json.dumps({"seed": SEED, "systems": {k: str(v.relative_to(ROOT)) for k, v in SYSTEMS.items()}, "cases": pool}, indent=2) + "\n")
    html = RATER_HTML.replace("__DATA__", json.dumps(cases).replace("</", "<\\/"))
    (OUT_DIR / "rate.html").write_text(html)
    total = sum(len(c["passages"]) for c in cases)
    print(f"Wrote research/retrieval_eval/rate.html ({N_CASES} cases, {total} passages to rate) and pool.json")


def dcg(gains):
    return sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(gains))


def bootstrap_ci(values, n=2000, seed=42):
    rng = random.Random(seed)
    means = sorted(sum(rng.choice(values) for _ in values) / len(values) for _ in range(n))
    return [means[int(0.025 * n)], means[int(0.975 * n)]]


def sign_test(diffs):
    pos, neg = sum(d > 0 for d in diffs), sum(d < 0 for d in diffs)
    k, m = min(pos, neg), pos + neg
    if m == 0:
        return pos, neg, 1.0
    return pos, neg, min(1.0, 2 * sum(math.comb(m, i) for i in range(k + 1)) / 2**m)


def score(path):
    ratings = json.loads(Path(path).read_text())
    pool = json.loads((OUT_DIR / "pool.json").read_text())
    missing = [p["key"] for c in pool["cases"] for p in c["passages"] if p["key"] not in ratings]
    if missing:
        raise SystemExit(f"{len(missing)} passages are unrated (e.g. {missing[:5]}). Finish rating first.")

    per_case = {name: {"p5": [], "strictP5": [], "meanRel": [], "ndcg5": []} for name in SYSTEMS}
    for case in pool["cases"]:
        all_gains = sorted((ratings[p["key"]] for p in case["passages"]), reverse=True)
        ideal = dcg(all_gains[:5]) or 1.0
        for name in SYSTEMS:
            top = sorted((p for p in case["passages"] if p[f"{name}Rank"]), key=lambda p: p[f"{name}Rank"])
            gains = [ratings[p["key"]] for p in top]
            per_case[name]["p5"].append(sum(g >= 1 for g in gains) / 5)
            per_case[name]["strictP5"].append(sum(g == 2 for g in gains) / 5)
            per_case[name]["meanRel"].append(sum(gains) / 5)
            per_case[name]["ndcg5"].append(dcg(gains) / ideal)

    results = {"cases": len(pool["cases"]), "systems": {}}
    for name, metrics in per_case.items():
        results["systems"][name] = {
            m: {"mean": sum(v) / len(v), "ci95": bootstrap_ci(v)} for m, v in metrics.items()
        }
    diffs = [b - a for a, b in zip(per_case["baseline"]["p5"], per_case["improved"]["p5"])]
    better, worse, p = sign_test(diffs)
    results["signTestP5"] = {"improvedBetter": better, "baselineBetter": worse, "p": p}
    (OUT_DIR / "results.json").write_text(json.dumps(results, indent=2) + "\n")

    print(f"Retrieval quality on {results['cases']} cases (95% bootstrap CI)")
    for name, m in results["systems"].items():
        cells = "  ".join(f"{k} {v['mean']:.3f} [{v['ci95'][0]:.3f}, {v['ci95'][1]:.3f}]" for k, v in m.items())
        print(f"  {name:9} {cells}")
    print(f"  sign test on P@5: improved better in {better}, baseline better in {worse}, p = {p:.4f}")
    print("Wrote research/retrieval_eval/results.json")


def check():
    """A rating page with N_CHECK random passages, stored and downloaded separately from rate.html."""
    cases, pool = build()
    pooled = {p["key"] for c in json.loads((OUT_DIR / "pool.json").read_text())["cases"] for p in c["passages"]}
    keys = sorted(p["key"] for c in cases for p in c["passages"])
    if set(keys) != pooled:
        raise SystemExit("pool.json does not match the current inputs; re-run `make` first.")
    chosen = set(random.Random(SEED + 1).sample(keys, N_CHECK))
    subset = [{**c, "passages": [p for p in c["passages"] if p["key"] in chosen]} for c in cases]
    subset = [c for c in subset if c["passages"]]
    html = (RATER_HTML.replace("__DATA__", json.dumps(subset).replace("</", "<\\/"))
            .replace("'retrieval-ratings-v1'", "'retrieval-ratings-check-v1'")
            .replace("a.download = 'ratings.json';", "a.download = 'ratings_check.json';")
            .replace("research/retrieval_eval/ratings.json", "research/retrieval_eval/ratings_check.json"))
    (OUT_DIR / "rate_check.html").write_text(html)
    print(f"Wrote research/retrieval_eval/rate_check.html ({N_CHECK} passages from {len(subset)} cases)")


def quadratic_kappa(pairs, k=3):
    n = len(pairs)
    obs = [[0] * k for _ in range(k)]
    for a, b in pairs:
        obs[a][b] += 1
    rows = [sum(obs[i]) for i in range(k)]
    cols = [sum(obs[i][j] for i in range(k)) for j in range(k)]
    w = lambda i, j: (i - j) ** 2 / (k - 1) ** 2
    observed = sum(w(i, j) * obs[i][j] for i in range(k) for j in range(k))
    expected = sum(w(i, j) * rows[i] * cols[j] / n for i in range(k) for j in range(k))
    return 1 - observed / expected if expected else 1.0


def agree(path):
    main = json.loads((OUT_DIR / "ratings.json").read_text())
    second = json.loads(Path(path).read_text())
    pairs = [(main[k], second[k]) for k in sorted(second) if k in main]
    if not pairs:
        raise SystemExit("No overlapping passages.")
    n = len(pairs)
    exact = sum(a == b for a, b in pairs) / n
    useful = sum((a >= 1) == (b >= 1) for a, b in pairs) / n
    kappa = quadratic_kappa(pairs)
    out = {"n": n, "exactAgreement": exact, "usefulAgreement": useful, "quadraticKappa": kappa}
    (OUT_DIR / "agreement.json").write_text(json.dumps(out, indent=2) + "\n")
    print(f"{n} passages rated by both: exact agreement {exact:.2f}, agreement on useful (>=1) {useful:.2f}, "
          f"quadratic-weighted kappa {kappa:.2f}. Wrote research/retrieval_eval/agreement.json")


RATER_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retrieval rating</title>
<style>
  :root { --bg:#fafaf9; --card:#fff; --ink:#1c1917; --muted:#78716c; --line:#e7e5e4; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --card:#292524; --ink:#f5f5f4; --muted:#a8a29e; --line:#44403c; --accent:#60a5fa; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:860px; margin:0 auto; padding:16px; }
  .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
  .bar .grow { flex:1; color:var(--muted); }
  button { font:inherit; padding:6px 12px; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:6px; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .patient, .passage { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:12px; }
  .patient { border-left:4px solid var(--accent); }
  .source { color:var(--muted); font-size:13px; margin-bottom:6px; }
  .text { white-space:pre-wrap; max-height:260px; overflow:auto; }
  .rate { display:flex; gap:6px; margin-top:10px; flex-wrap:wrap; }
  .rate label { border:1px solid var(--line); border-radius:6px; padding:4px 10px; cursor:pointer; }
  .rate input { margin-right:6px; }
  .rate input:checked + span { font-weight:600; }
  details { margin-bottom:12px; color:var(--muted); }
</style></head>
<body><main>
<h1 style="font-size:20px;margin:4px 0 8px">Retrieval rating</h1>
<details open><summary>How to rate</summary>
<p>For each passage, judge how useful it is for deciding <b>this patient's ESI triage level</b>.
<b>2</b> = directly useful (a criterion that applies to this patient: a high-risk presentation, danger-zone vitals, a life-saving intervention, a resource rule).
<b>1</b> = somewhat useful (related background).
<b>0</b> = not useful. Ratings save in this browser as you go. When every passage is rated, click "Download ratings" and move the file to research/retrieval_eval/ratings.json.</p></details>
<div class="bar"><button id="prev">Previous</button><button id="next">Next</button><span class="grow" id="progress"></span><button class="primary" id="download">Download ratings</button></div>
<div id="case"></div>
</main>
<script>
const CASES = __DATA__;
const KEY = 'retrieval-ratings-v1';
let ratings = {};
try { ratings = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
let idx = 0;
const total = CASES.reduce((n, c) => n + c.passages.length, 0);
function save() { try { localStorage.setItem(KEY, JSON.stringify(ratings)); } catch (e) {} }
function esc(s) { return s.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }
function render() {
  const c = CASES[idx];
  const done = Object.keys(ratings).length;
  document.getElementById('progress').textContent = `Case ${idx + 1} of ${CASES.length} · ${done} of ${total} passages rated`;
  document.getElementById('case').innerHTML =
    `<div class="patient"><b>Patient</b><br>${esc(c.patient)}</div>` +
    c.passages.map(p => `<div class="passage"><div class="source">${esc(p.source)}</div><div class="text">${esc(p.text)}</div>
      <div class="rate">${[2,1,0].map(v => `<label><input type="radio" name="${p.key}" value="${v}" ${ratings[p.key] === v ? 'checked' : ''}><span>${v} ${['not useful','somewhat useful','directly useful'][v]}</span></label>`).join('')}</div></div>`).join('');
  document.querySelectorAll('input[type=radio]').forEach(el => el.addEventListener('change', () => { ratings[el.name] = Number(el.value); save(); render(); }));
}
document.getElementById('prev').onclick = () => { if (idx > 0) { idx--; render(); scrollTo(0, 0); } };
document.getElementById('next').onclick = () => { if (idx < CASES.length - 1) { idx++; render(); scrollTo(0, 0); } };
document.getElementById('download').onclick = () => {
  const missing = total - Object.keys(ratings).length;
  if (missing && !confirm(`${missing} passages are still unrated. Download anyway?`)) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(ratings, null, 2)], {type: 'application/json'}));
  a.download = 'ratings.json';
  a.click();
};
render();
</script></body></html>
"""


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("make", "score", "check", "agree"):
        raise SystemExit(__doc__)
    if sys.argv[1] == "make":
        make()
    elif sys.argv[1] == "check":
        check()
    elif sys.argv[1] == "agree":
        agree(sys.argv[2] if len(sys.argv) > 2 else OUT_DIR / "ratings_check.json")
    else:
        score(sys.argv[2] if len(sys.argv) > 2 else OUT_DIR / "ratings.json")
