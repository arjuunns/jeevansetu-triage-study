# Research pipeline: safety rules, ESI guidance and RAG on MIMIC-IV-ED

Reproduces every number in the paper. Run from the repo root.

```bash
python3 -I research/build_cohort.py                          # 1. data/mimic_ed_cohort.json
ollama serve & ollama pull bge-m3                            # 2. local embeddings (and step 5 models)
pnpm --filter @jeevansetu/server mimic:retrieval-cache        # 3. research/retrieval_cache.json (GEMINI_API_KEY for the rerank)
python3 -I research/retrieval_eval.py make                    # 4. blinded retrieval rating page
ollama pull qwen2.5:7b llama3.1:8b                            # 5. triage models
research/run_ablation.sh qwen2.5:7b llama3.1:8b              # 6. research/results/<run>.json (resumable)
ollama pull gemma3:12b && research/run_extra.sh              # 6b. exploratory arm + a third model (resumable)
bash research/run_gpu.sh                                      # 6c. gemma3:27b and medgemma:27b, on the university GPU server (GPU.md)
python3 -I research/analyze.py                                # 7. research/results/summary.{md,json}
python3 -I research/results_tables.py                         # 7b. paper tables and Fig. components (pending runs shown as TODO)
python3 -I research/failure_examples.py                       # 7c. counts and examples for Failure Modes
python3 -I research/retrieval_eval.py score                   # 8. retrieval quality, after rating
```

**Local reranker and pipeline v2 (8 to 11 Nov 2026).** The first runs reranked with gemini-3.5-flash-lite through the Gemini API. Pipeline v2 replaces only that step with the cross-encoder BAAI/bge-reranker-v2-m3 (revision 953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e, `research/rerank_server.py`), which scores each of the 20 fused candidates against the query (prefixed "Emergency Severity Index (ESI) triage guidance for this patient:") and keeps the 5 highest; together with the corrected ESI guide and the ESI v4 handbook corpus (`medical-pdf/ingestion/index_v4/`), it gives `research/retrieval_cache.v2.json`. All guide and retrieval setups were rerun with it (research/run_v2.sh, finished 11 Nov 2026); the paper reports only pipeline v2. Pipeline v1 is kept in research/results_v1/.

```bash
uv venv --python 3.12 research/.venv-rerank
uv pip install --python research/.venv-rerank/bin/python torch sentence-transformers
research/.venv-rerank/bin/python research/rerank_server.py --device cpu    # or --device cuda on the GPU server
pnpm --filter @jeevansetu/server mimic:retrieval-cache --rerank=local       # research/retrieval_cache.local.json
python3 -I research/compare_rerankers.py                                     # overlap with the Gemini picks
pnpm --filter @jeevansetu/server mimic:eval --model=<m> --rag=on --safety=on --retrieval-cache=../../research/retrieval_cache.local.json \
    --out=../../research/results_local/<m>__rag-on__safety-on.json   # never --fresh on research/results/: that would overwrite the Gemini runs
```

A single condition: `pnpm --filter @jeevansetu/server mimic:eval --model=qwen2.5:7b --rag=on --safety=off [--guide=on] [--limit=5]`.

**GPU runs for the 27B models (11 Nov 2026).** `research/run_gpu.sh` runs Gemma 3 27B and MedGemma 27B (official Ollama builds, Q4_K_M) through the 7 setups with exactly pipeline v2: it checks the cohort, retrieval cache, guide and system-prompt fingerprints against the laptop runs, installs Node.js 22, the server packages and Ollama 0.32.14 without root, starts its own Ollama on port 11535, pulls the models, runs a 2-patient smoke test per model, then the runs (resumable), and packs `research/gpu_results_<date>.tar.gz`. `bash research/run_gpu.sh check` does only the checks. Tested 11 Nov 2026 on macOS (fresh clone) and on clean Ubuntu 24.04 (Docker) with a small model.

## Design decisions (Methods)

**Data.** MIMIC-IV-ED Demo v2.2 plus the MIMIC-IV Demo v2.2 `patients` table for age (PhysioNet, open access, ODbL 1.0). All 207 ED stays with a recorded triage acuity; 15 stays without acuity are excluded. Reference ESI distribution: 1: 18, 2: 97, 3: 90, 4: 2, 5: 0. The reference standard is the triage nurse's ESI, not expert consensus.

**Inputs (no leakage).** Only information available at triage: age, sex, arrival mode, chief complaint, triage vitals and numeric pain score. Not used: discharge diagnoses, disposition, later vital signs, GCS (not recorded at MIMIC triage) and free-text pain entries. Missing vitals stay missing; implausible values are set to missing and listed in the cohort file's `meta`.

**Conditions.** Rules only (safety engine plus vital-sign heuristic, no LLM) and six LLM conditions per model: LLM only; + safety; + ESI guide; + ESI guide + safety; + RAG; full (RAG + safety). The system prompt is identical in every LLM condition; conditions differ only in which sections the user prompt contains (safety verdict, ESI algorithm reference, retrieved excerpts). "Safety on" also enforces the post-hoc override to ESI 1 when a rule fires.

**Models.** Main: qwen2.5:7b (Alibaba) and llama3.1:8b (Meta), all conditions (`run_ablation.sh`). Added after the main runs were queued, before any of their results: gemma3:12b (Google, a third general model family), all conditions (`run_extra.sh`). medgemma:4b (Google, Gemma 3 adapted to medical text and images) was planned too but dropped on 30 Oct 2026 before it produced any result: at temperature 0 it repeated sentences in its reasoning until the context window filled, on the first patient (evidence and replay in `research/medgemma_probe/`). All models share one decoding setup, so it was not rerun with a repetition penalty. Mid-sized: medgemma:27b (Google, Gemma 3 27B adapted to medical text), added on 30 Oct 2026 after the qwen and llama runs had finished, to test a larger medical model, and gemma3:27b (its general base model), added on 8 Nov 2026 so the two can be compared at the same size; all seven setups each on a university GPU server (computing resources provided by Thapar Institute), because they do not fit in the laptop's memory. Run with `research/run_gpu.sh` on 14 to 15 Nov 2026 (dgxhnode1: 40 GB MIG partition, 3g.40gb, of an NVIDIA H100 80GB; Ollama 0.32.14; official Ollama builds gemma3:27b digest 6be2e2ba..., 27.0B, and medgemma:27b digest 58238ae3..., 27.4B, both Q4_K_M; guide, system prompt and retrieval cache fingerprints identical to the laptop runs; details in `research/gpu_run_info.json`); 207/207 valid answers in all 14 runs. In the paper from 15 Nov 2026 (35 LLM runs in total). The paper calls models up to about 12B small (they run on a laptop) and about 20 to 30B mid-sized (in 4-bit form they fit on one workstation GPU). All 4-bit quantised (Q4_K_M) Ollama builds; the three small models run on one laptop (Apple M4, 24 GB).

**Exploratory condition (post hoc, label it so).** Added after the first qwen results showed that safety-on raised under-triage (30.9% to 39.1%) while the post-hoc override never fired. Hypothesis: the "no critical red flags detected. Assess normally." line, shown in the 193 cases where no rule fires, reassures the model. "Safety, no notice" keeps the rules, the CRITICAL verdict when a rule fires and the override, but says nothing otherwise (`--safety-notice=off`). Run for all five models. Prompts of the pre-specified conditions were verified byte-identical before and after this change (sha256 over all 1,656 case-by-condition prompts).

**ESI guide.** A curated summary of the ESI v4 algorithm (decision points A to D, life-saving interventions, high-risk examples, resource rules, danger-zone vitals), paraphrased from the ESI v4 Implementation Handbook (Gilboy et al., AHRQ Publication No. 05-0046-2, 2005), in `apps/server/src/modules/triage/esi.guide.ts`. Checked against that handbook on 29 Oct 2026, after the runs had started: it omits acute mental status change as a decision point A condition (the guide mentions confusion only under B), and joins the 3-month-to-3-year fever criteria with "and" where the handbook has "or" (no effect: all patients are adults). Pipeline v1 left it unchanged so every run used the same text. Pipeline v2 (9 Nov 2026) corrected both points against the 2012 edition of the v4 handbook (AHRQ Publication No. 12-0014) and reran every setup that uses the guide or retrieval; all results in the paper use the corrected guide. The guide condition includes it whole; RAG can retrieve it as chunks.

**Retrieval.** Corpus: 386 chunks from `medical-pdf/ingestion` (WHO and ICRC *Basic Emergency Care* `9789241513081-eng.pdf`: 309; ESI Handbook, 5th edition, ESI v5, ENA 2023: 77) plus 13 paragraph-level chunks of the ESI guide. Excluded before any RAG results were seen: the 38-chunk abbreviations list (no triage guidance). The CTAS PDF was never ingested. Query: age, sex, chief complaint with common ED abbreviations expanded, and abnormal vitals named using ESI danger-zone thresholds. Candidates: dense cosine search (bge-m3 via Ollama, run locally, 1024 dims) and BM25, fused by reciprocal rank fusion (k = 60), top 20. Reranking: gemini-3.5-flash-lite picks the 5 passages most useful for assigning an ESI level. Excerpts carry the full chunk text (up to 2,000 characters). Computed once per case and cached, so all models and conditions see identical excerpts. Curated chunks were split to paragraph level after a 3-case smoke test showed section-level chunks never reached the candidate pool (inputs only; no labels used). This paragraph describes pipeline v1. Pipeline v2, which the paper reports: the ESI v5 handbook is replaced by chapters 2 to 6 and Appendix B of the ESI v4 handbook, 2012 edition (pages 16 to 60 and 109 to 110 of AHRQ Publication No. 12-0014, 88 passages, `medical-pdf/ingestion/local_ingest.py`, no cloud calls), giving 410 passages in `medical-pdf/ingestion/index_v4/`; the Gemini rerank is replaced by the local bge-reranker-v2-m3 cross-encoder; the query also names very slow breathing and severe hypertension; the cache is `research/retrieval_cache.v2.json`.

**Decoding.** Temperature 0, seed 42, context window 8,192 tokens, JSON-schema-constrained output, up to 3 attempts. Each case is `ok` (valid model output), `fallback` (all attempts failed; heuristic answered) or `error`. Metrics use `ok` cases; the other counts are reported per run.

**Statistics.** Exact accuracy, within-one accuracy, under-triage (predicted less urgent than reference), over-triage, severe under-triage (two or more levels) and quadratic-weighted kappa; high-acuity detection (ESI 1-2 vs 3-5: sensitivity, specificity, PPV, NPV); under-triage among patients later admitted; expected calibration error of self-reported confidence. 95% percentile-bootstrap CIs (2,000 resamples) over visits and, because the 207 visits come from 56 patients, over patients (`ci95Patient`). Paired condition comparisons: the exact McNemar test on cases valid in both runs (`p`) and a patient-level paired permutation test with 20,000 permutations (`pPatient`); the paper reports the patient-level CIs and p values. p values are Holm-adjusted within each model and metric; the exploratory comparisons are a separate family. Safety-rule precision and sensitivity come from the deterministic rules alone.

**Retrieval quality.** 30 randomly sampled cases; the top-5 passages from the earlier retrieval (dense only, raw complaint query, 600-character excerpts) and the final retrieval are pooled, shuffled and rated blind (0, 1, 2) for usefulness in assigning the patient's ESI level. Pipeline v2 (11 Nov 2026, reported in the paper): the earlier retrieval was rebuilt on the same v4 corpus with bge-m3 and the stored v1 queries (`build_retrieval_cache.ts --rerank=off --corpus=.../index_v4/... --baseline-queries=research/retrieval_cache_baseline.json` writes `research/retrieval_cache_baseline.v2.json`); `retrieval_eval.py make|score` now default to v2 (`research/retrieval_eval_v2/`: blinded_cases.json, pool.json, passage_ids.json, passage_notes.json for the 93 distinct passages, ratings.json, results.json); `--v1` after the command uses the first evaluation in `research/retrieval_eval/`. Rater both times: Claude Opus 5.5, shown only the blinded data (never pool.json): it wrote a note per distinct passage, then scored each patient's passages. The same assistant helped build the improved retrieval, so `retrieval_eval.py check` makes a 50-passage page (`rate_check.html`) for a human rater, and `agree` reports exact agreement and quadratic-weighted kappa. Reported: precision@5, strict precision@5, mean graded relevance, nDCG@5, and an exact sign test on per-case precision@5.

## Files

| Path | What |
|---|---|
| `research/build_cohort.py` | Builds the cohort from the raw CSVs |
| `apps/server/scripts/mimic_cohort.ts` | Loads the cohort; converts triage inputs to engine inputs |
| `apps/server/scripts/build_retrieval_cache.ts` | Hybrid retrieval + rerank, cached per case |
| `apps/server/scripts/evaluate_mimic.ts` | Runs one condition |
| `research/run_ablation.sh` | Runs every condition for the given models |
| `research/run_extra.sh` | Exploratory no-notice condition, then every condition for gemma3:12b |
| `research/run_model.sh` | All seven setups for the given models (laptop) |
| `research/run_gpu.sh` | All seven setups for gemma3:27b and medgemma:27b on the GPU server, with fingerprint checks (GPU.md) |
| `research/analyze.py` | Statistics and tables |
| `research/robustness_checks.py` | Checks from the saved run files, no new runs (15 Nov 2026, after a review): override applied after the fact to the no-safety setups, answer agreement of no-notice vs LLM only on unflagged visits, patient-weighted exact agreement and under-triage; writes `research/results/robustness_checks.json` |
| `research/results_tables.py` | Paper results tables and the component-effect figure, from summary.json |
| `research/failure_examples.py` | Failure-mode counts and examples from the run files |
| `research/retrieval_eval.py` | Blinded retrieval rating and scoring |
| `research/public_cache.py` | Public copies of the retrieval caches without ESI handbook text (`strip`), and `restore` from a rebuilt index |
| `research/export_public.py` | Builds the public study repository from an allow-list (no paper draft, no handbook text); README and data notes in `research/public_repo/` |

The earlier `data/mimic_benchmark_150.json` and root `mimic_benchmark_*` files were deleted: they leaked the label (severity and GCS derived from ESI, discharge diagnoses as history, invented ages). `apps/server/scripts/ingest_mimic.ts` and `run_100_patients_ollama_benchmark.ts` still expect that file and are not part of this pipeline.
