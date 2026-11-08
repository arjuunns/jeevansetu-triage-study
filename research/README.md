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
ollama pull medgemma:27b && research/run_model.sh medgemma:27b  # 6c. mid-sized medical model, on the university GPU server
python3 -I research/analyze.py                                # 7. research/results/summary.{md,json}
python3 -I research/results_tables.py                         # 7b. paper tables and Fig. components (pending runs shown as TODO)
python3 -I research/failure_examples.py                       # 7c. counts and examples for Failure Modes
python3 -I research/retrieval_eval.py score                   # 8. retrieval quality, after rating
```

A single condition: `pnpm --filter @jeevansetu/server mimic:eval --model=qwen2.5:7b --rag=on --safety=off [--guide=on] [--limit=5]`.

## Design decisions (Methods)

**Data.** MIMIC-IV-ED Demo v2.2 plus the MIMIC-IV Demo v2.2 `patients` table for age (PhysioNet, open access, ODbL 1.0). All 207 ED stays with a recorded triage acuity; 15 stays without acuity are excluded. Reference ESI distribution: 1: 18, 2: 97, 3: 90, 4: 2, 5: 0. The reference standard is the triage nurse's ESI, not expert consensus.

**Inputs (no leakage).** Only information available at triage: age, sex, arrival mode, chief complaint, triage vitals and numeric pain score. Not used: discharge diagnoses, disposition, later vital signs, GCS (not recorded at MIMIC triage) and free-text pain entries. Missing vitals stay missing; implausible values are set to missing and listed in the cohort file's `meta`.

**Conditions.** Rules only (safety engine plus vital-sign heuristic, no LLM) and six LLM conditions per model: LLM only; + safety; + ESI guide; + ESI guide + safety; + RAG; full (RAG + safety). The system prompt is identical in every LLM condition; conditions differ only in which sections the user prompt contains (safety verdict, ESI algorithm reference, retrieved excerpts). "Safety on" also enforces the post-hoc override to ESI 1 when a rule fires.

**Models.** Main: qwen2.5:7b (Alibaba) and llama3.1:8b (Meta), all conditions (`run_ablation.sh`). Added after the main runs were queued, before any of their results: gemma3:12b (Google, a third general model family), all conditions (`run_extra.sh`). medgemma:4b (Google, Gemma 3 adapted to medical text and images) was planned too but dropped on 30 Oct 2026 before it produced any result: at temperature 0 it repeated sentences in its reasoning until the context window filled, on the first patient (evidence and replay in `research/medgemma_probe/`). All models share one decoding setup, so it was not rerun with a repetition penalty. Mid-sized: medgemma:27b (Google, Gemma 3 27B adapted to medical text), added on 30 Oct 2026 after the qwen and llama runs had finished, to test a larger medical model; all seven setups (`run_model.sh`) on a university GPU server, because it does not fit in the laptop's memory (hardware and Ollama version to be recorded from the server). The paper calls models up to about 12B small (they run on a laptop) and about 20 to 30B mid-sized (in 4-bit form they fit on one workstation GPU). All 4-bit quantised Ollama builds, run on one laptop (Apple M4, 24 GB).

**Exploratory condition (post hoc, label it so).** Added after the first qwen results showed that safety-on raised under-triage (30.9% to 39.1%) while the post-hoc override never fired. Hypothesis: the "no critical red flags detected. Assess normally." line, shown in the 193 cases where no rule fires, reassures the model. "Safety, no notice" keeps the rules, the CRITICAL verdict when a rule fires and the override, but says nothing otherwise (`--safety-notice=off`). Run for all three models. Prompts of the pre-specified conditions were verified byte-identical before and after this change (sha256 over all 1,656 case-by-condition prompts).

**ESI guide.** A curated summary of the ESI v4 algorithm (decision points A to D, life-saving interventions, high-risk examples, resource rules, danger-zone vitals), paraphrased from the ESI v4 Implementation Handbook (Gilboy et al., AHRQ Publication No. 05-0046-2, 2005), in `apps/server/src/modules/triage/esi.guide.ts`. Checked against that handbook on 29 Oct 2026, after the runs had started: it omits acute mental status change as a decision point A condition (the guide mentions confusion only under B), and joins the 3-month-to-3-year fever criteria with "and" where the handbook has "or" (no effect: all patients are adults). Left unchanged so every run uses the same text. The guide condition includes it whole; RAG can retrieve it as chunks.

**Retrieval.** Corpus: 386 chunks from `medical-pdf/ingestion` (WHO and ICRC *Basic Emergency Care* `9789241513081-eng.pdf`: 309; ESI Handbook, 5th edition, ESI v5, ENA 2023: 77) plus 13 paragraph-level chunks of the ESI guide. Excluded before any RAG results were seen: the 38-chunk abbreviations list (no triage guidance). The CTAS PDF was never ingested. Query: age, sex, chief complaint with common ED abbreviations expanded, and abnormal vitals named using ESI danger-zone thresholds. Candidates: dense cosine search (bge-m3 via Ollama, run locally, 1024 dims) and BM25, fused by reciprocal rank fusion (k = 60), top 20. Reranking: gemini-3.5-flash-lite picks the 5 passages most useful for assigning an ESI level. Excerpts carry the full chunk text (up to 2,000 characters). Computed once per case and cached, so all models and conditions see identical excerpts. Curated chunks were split to paragraph level after a 3-case smoke test showed section-level chunks never reached the candidate pool (inputs only; no labels used).

**Decoding.** Temperature 0, seed 42, context window 8,192 tokens, JSON-schema-constrained output, up to 3 attempts. Each case is `ok` (valid model output), `fallback` (all attempts failed; heuristic answered) or `error`. Metrics use `ok` cases; the other counts are reported per run.

**Statistics.** Exact accuracy, within-one accuracy, under-triage (predicted less urgent than reference), over-triage, severe under-triage (two or more levels) and quadratic-weighted kappa; high-acuity detection (ESI 1-2 vs 3-5: sensitivity, specificity, PPV, NPV); under-triage among patients later admitted; expected calibration error of self-reported confidence. 95% percentile-bootstrap CIs (2,000 resamples). Paired condition comparisons use the exact McNemar test on cases valid in both runs. p values are Holm-adjusted within each model and metric; the exploratory comparisons are a separate family. Safety-rule precision and sensitivity come from the deterministic rules alone.

**Retrieval quality.** 30 randomly sampled cases; the top-5 passages from the baseline retrieval (`research/retrieval_cache_baseline.json`: dense only, raw complaint query, 600-character excerpts) and the improved retrieval are pooled, shuffled and rated blind (0, 1, 2) for usefulness in assigning the patient's ESI level. Rater: Claude Opus 5.5 (29 Oct 2026), shown only the blinded rate.html data (never pool.json): it wrote a note per distinct passage, then scored each patient's passages; ratings in `research/retrieval_eval/ratings.json`. The same assistant helped build the improved retrieval, so `retrieval_eval.py check` makes a 50-passage page (`rate_check.html`) for a human rater, and `agree` reports exact agreement and quadratic-weighted kappa. Reported: precision@5, strict precision@5, mean graded relevance, nDCG@5, and an exact sign test on per-case precision@5.

## Files

| Path | What |
|---|---|
| `research/build_cohort.py` | Builds the cohort from the raw CSVs |
| `apps/server/scripts/mimic_cohort.ts` | Loads the cohort; converts triage inputs to engine inputs |
| `apps/server/scripts/build_retrieval_cache.ts` | Hybrid retrieval + rerank, cached per case |
| `apps/server/scripts/evaluate_mimic.ts` | Runs one condition |
| `research/run_ablation.sh` | Runs every condition for the given models |
| `research/run_extra.sh` | Exploratory no-notice condition, then every condition for gemma3:12b |
| `research/run_model.sh` | All seven setups for the given models (used for medgemma:27b on the GPU server) |
| `research/analyze.py` | Statistics and tables |
| `research/results_tables.py` | Paper results tables and the component-effect figure, from summary.json |
| `research/failure_examples.py` | Failure-mode counts and examples from the run files |
| `research/retrieval_eval.py` | Blinded retrieval rating and scoring |
| `research/public_cache.py` | Public copies of the retrieval caches without ESI handbook text (`strip`), and `restore` from a rebuilt index |
| `research/export_public.py` | Builds the public study repository from an allow-list (no paper draft, no handbook text); README and data notes in `research/public_repo/` |

The earlier `data/mimic_benchmark_150.json` and root `mimic_benchmark_*` files were deleted: they leaked the label (severity and GCS derived from ESI, discharge diagnoses as history, invented ages). `apps/server/scripts/ingest_mimic.ts` and `run_100_patients_ollama_benchmark.ts` still expect that file and are not part of this pipeline.
