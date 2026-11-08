# Safety rules, algorithm prompts and guideline retrieval for local language models in emergency triage

Code, prompts, data and results for the paper *Safety Rules, Algorithm Prompts and Guideline Retrieval for Local Language Models in Emergency Triage* by Arjun Singh and Garima Singh (Department of Computer Science and Engineering, Thapar Institute of Engineering and Technology). The paper is under review; a link will be added when it is published.

The study takes the triage pipeline of JeevanSetu, a triage and referral system in which a doctor reviews every AI suggestion, and switches its parts on and off: fixed safety rules with a hard override to ESI 1, a summary of the Emergency Severity Index (ESI) algorithm in the prompt, and retrieval of guideline passages. It tests them with open-weight models run locally through Ollama on 207 visits from the MIMIC-IV-ED demo, against the triage nurse's ESI level. `research/README.md` has the full method notes.

## Where things are

| Path | What |
|---|---|
| `apps/server/src/modules/safety/` | The 14 red-flag rules |
| `apps/server/src/modules/triage/esi.guide.ts` | The ESI algorithm summary used in the "ESI guide" setups (ESI version 4, in our own words) |
| `apps/server/src/modules/triage/triage.prompts.ts` | System prompt and user prompt |
| `apps/server/src/modules/triage/triage.engine.ts` | Model call, JSON output, retries, and the override to ESI 1 when a safety rule fires |
| `apps/server/src/modules/rag/` | Query building and retrieval |
| `apps/server/scripts/evaluate_mimic.ts` | Runs one setup for one model |
| `apps/server/scripts/build_retrieval_cache.ts` | Retrieval and reranking, cached once per patient |
| `research/build_cohort.py` | Builds the cohort from the MIMIC files, using only information available at triage |
| `research/run_ablation.sh`, `run_extra.sh`, `run_model.sh` | Run every setup for the given models |
| `research/analyze.py` | Metrics, bootstrap confidence intervals, McNemar tests with Holm adjustment |
| `research/results/` | The output of every run (one JSON file per model and setup, with every answer and explanation) and `summary.json` |
| `research/retrieval_eval/` | Blinded ratings of retrieved passages and their scores |
| `data/` | MIMIC-IV-ED Demo and MIMIC-IV Demo files, and the cohort (`mimic_ed_cohort.json`) |
| `medical-pdf/ingestion/` | Code that splits the guideline PDFs into passages |

The rest of `apps/server` is the JeevanSetu platform (database, routing, referrals); the study uses only the parts above.

## Reproducing the results

Requirements: Node.js 20 or later, pnpm 9 or later, Python 3.9 or later, and [Ollama](https://ollama.com).

```bash
pnpm install
cp .env.example .env                               # the placeholder values are enough; no database is used
pnpm --filter @jeevansetu/types build
pnpm --filter @jeevansetu/server db:generate      # generates the database client the server code imports
python3 -I research/build_cohort.py               # optional: data/mimic_ed_cohort.json is included

cd apps/server && pnpm mimic:eval --rules-only && cd ../..   # rules-only baseline, no model needed

ollama pull qwen2.5:7b && ollama pull llama3.1:8b && ollama pull gemma3:12b
research/run_ablation.sh qwen2.5:7b llama3.1:8b    # every setup for these models
research/run_extra.sh                              # exploratory setup and gemma3:12b
research/run_model.sh medgemma:27b                 # needs a GPU with about 20 GB of memory

python3 -I research/analyze.py                     # writes research/results/summary.json and summary.md
```

Runs resume where they stopped, and a finished result file is skipped. To repeat a run, move its file out of `research/results/` first. All runs use temperature 0, seed 42 and 4-bit Ollama builds; the paper lists the exact model versions. Answers can differ slightly on other hardware.

## Retrieval and the ESI handbook

The setups with retrieval read `research/retrieval_cache.json`, which holds the five passages each patient's model saw. Most passages come from the *Emergency Severity Index Handbook*, 5th edition (Emergency Nurses Association, 2023). It is copyrighted, so this repository does not include it or its text. `research/retrieval_cache.public.json` keeps every passage from the WHO and ICRC manual and from our own ESI guide, but only the chunk IDs of the handbook passages.

To restore the full cache:

1. Buy the ESI Handbook (5th edition) and save it as `medical-pdf/Emergency_Severity_Index_Handbook.pdf`.
2. Download *Basic Emergency Care: Approach to the Acutely Ill and Injured* (WHO and ICRC, 2018, ISBN 978-92-4-151308-1) and save it as `medical-pdf/9789241513081-eng.pdf`.
3. Rebuild the passages: `cd medical-pdf/ingestion && pip install -r requirements.txt && python main.py --no-pinecone`. This needs `GEMINI_API_KEY` in `.env` (copy `.env.example`), because the script embeds the passages and converts tables with Gemini.
4. `python3 -I research/public_cache.py restore`

A chunk ID is a hash of the passage text, so paragraph passages come back exactly. A few passages were made from tables by an LLM during ingestion, and these usually come out different; the script reports them. Rebuilding the cache from scratch (`pnpm --filter @jeevansetu/server mimic:retrieval-cache`) also needs a Gemini key for reranking and will not give identical passages.

## Data and licences

`data/` holds files from the MIMIC-IV-ED Demo (v2.2) and the MIMIC-IV Demo (v2.2), published on PhysioNet under the Open Database License (ODbL) 1.0; see `data/README.md`. The run results are derived from them and are shared under the same licence. The code is under the MIT licence (`LICENSE`).
