# Safety rules, algorithm prompts and guideline retrieval for local language models in emergency triage

Code, prompts, data and results for the paper *Safety Rules, Algorithm Prompts and Guideline Retrieval for Local Language Models in Emergency Triage* by Arjun Singh and Garima Singh (Department of Computer Science and Engineering, Thapar Institute of Engineering and Technology). A link to the paper will be added when it is published.

The study takes the triage pipeline of JeevanSetu, a triage and referral system in which a doctor reviews every AI suggestion, and switches its parts on and off: fixed safety rules with a hard override to ESI 1, a summary of the Emergency Severity Index (ESI) algorithm in the prompt, and retrieval of guideline passages. It tests them with five open-weight models run locally through Ollama (Qwen2.5 7B, Llama 3.1 8B and Gemma 3 12B on a laptop; Gemma 3 27B and MedGemma 27B on one GPU) on 207 visits from the MIMIC-IV-ED demo, against the triage nurse's ESI level, and compares them with rule-based and machine-learning baselines. `research/README.md` has the full method notes.

All results are from pipeline v2: the ESI guide corrected against the 2012 edition of the ESI version 4 handbook, a retrieval corpus built from that handbook and the WHO and ICRC manual, and a local reranker. Nothing in the triage pipeline calls an online service.

## Where things are

| Path | What |
|---|---|
| `apps/server/src/modules/safety/` | The 14 red-flag rules |
| `apps/server/src/modules/triage/esi.guide.ts` | The ESI algorithm summary used in the "ESI guide" setups (ESI version 4, in our own words) |
| `apps/server/src/modules/triage/triage.prompts.ts` | System prompt and user prompt |
| `apps/server/src/modules/triage/triage.engine.ts` | Model call, JSON output, retries, and the override to ESI 1 when a safety rule fires |
| `apps/server/src/modules/rag/` | Query building and retrieval |
| `apps/server/scripts/evaluate_mimic.ts` | Runs one setup for one model |
| `apps/server/scripts/build_retrieval_cache.ts`, `research/rerank_server.py` | Retrieval and local reranking, cached once per visit |
| `research/build_cohort.py` | Builds the cohort from the MIMIC files, using only information available at triage |
| `research/run_gpu.sh` | Runs all seven setups for the given models, after checking that the cohort, prompts and retrieval cache match the study's |
| `research/analyze.py` | Metrics, patient-level bootstrap confidence intervals and paired permutation tests with Holm adjustment |
| `research/baselines_subgroups.py` | Non-LLM baselines (always ESI 2, NEWS, logistic regression, gradient boosting) |
| `research/robustness_checks.py` | Override-only, unflagged-visit and patient-weighted checks |
| `research/results/` | The output of all 35 runs (one JSON file per model and setup, with every answer and explanation), `summary.json` and the baseline and check results |
| `research/gpu_run_info.json` | Hardware, Ollama version and model digests of the two 27B runs |
| `research/retrieval_eval_v2/` | Blinded ratings of retrieved passages and their scores (`retrieval_eval/` holds the first evaluation, on the earlier pipeline) |
| `data/` | MIMIC-IV-ED Demo and MIMIC-IV Demo files, and the cohort (`mimic_ed_cohort.json`) |
| `medical-pdf/ingestion/` | Code that splits the guideline PDFs into passages |

The rest of `apps/server` is the JeevanSetu platform (database, routing, referrals); the study uses only the parts above.

## Retrieval and the ESI handbook

The setups with retrieval read `research/retrieval_cache.v2.json`, which holds the five passages each visit's model saw. Most of them come from *Emergency Severity Index (ESI): A Triage Tool for Emergency Department Care, Version 4, Implementation Handbook, 2012 Edition* (AHRQ Publication No. 12-0014). The ESI algorithm belongs to the ESI Triage Research Team, so this repository does not include the handbook or its passages. `research/retrieval_cache.v2.public.json` keeps every passage from the WHO and ICRC manual and from our own ESI guide, but only the chunk IDs of the handbook passages.

To restore the full cache:

1. Get the handbook PDF (114 pages), published by the Agency for Healthcare Research and Quality.
2. Cut out the pages the corpus uses and split them into passages (no online service is needed):

   ```bash
   cd medical-pdf/ingestion
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   .venv/bin/python extract_esi_v4_pages.py <handbook PDF> ../Emergency_Severity_Index_v4_Handbook_2012.pdf
   .venv/bin/python local_ingest.py --pdf ../Emergency_Severity_Index_v4_Handbook_2012.pdf --out index_v4/guidelines.metadata.jsonl
   cd ../..
   ```

3. `python3 -I research/public_cache.py restore`

A chunk ID is a hash of the file name and the passage text, and the extraction is deterministic, so the restored `research/retrieval_cache.v2.json` is byte-identical to the one the study used (`research/run_gpu.sh` checks its hash).

`research/retrieval_cache.public.json` is the cache of the earlier pipeline (ESI Handbook, 5th edition, Emergency Nurses Association, 2023, and a cloud reranker). The paper mentions that pipeline but reports no results from it; `research/public_cache.py` describes how to restore it.

## Reproducing the results

Requirements: Python 3.9 or later and [Ollama](https://ollama.com) 0.32.14. `research/run_gpu.sh` installs Node.js and the packages itself if they are missing. Restore the retrieval cache first (above).

```bash
python3 -I research/build_cohort.py               # optional: data/mimic_ed_cohort.json is included

# all seven setups for each model; despite its name, the script also runs on an Apple silicon laptop
MODELS="qwen2.5:7b llama3.1:8b gemma3:12b" bash research/run_gpu.sh
MODELS="gemma3:27b medgemma:27b" bash research/run_gpu.sh      # needs a GPU with 24 GB or more

cd apps/server && pnpm mimic:eval --rules-only --fresh && cd ../..   # rules-only baseline, no model needed
python3 -I research/analyze.py                     # research/results/summary.json and summary.md
python3 -I research/baselines_subgroups.py         # non-LLM baselines (needs scikit-learn)
python3 -I research/robustness_checks.py
```

Runs resume where they stopped, and a finished result file is skipped. To repeat a run, move its file out of `research/results/` first. All runs use temperature 0, seed 42, a context window of 8,192 tokens and 4-bit (Q4_K_M) Ollama builds; the paper and `research/gpu_run_info.json` list the exact versions. Answers can differ slightly on other hardware.

## Data and licences

`data/` holds files from the MIMIC-IV-ED Demo (v2.2) and the MIMIC-IV Demo (v2.2), published on PhysioNet under the Open Database License (ODbL) 1.0; see `data/README.md`. The run results are derived from them and are shared under the same licence. The code is under the MIT licence (`LICENSE`).
