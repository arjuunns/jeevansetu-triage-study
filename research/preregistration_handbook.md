# Pre-registration: confirmation on the ESI v4 handbook cases

Written on 16 Nov 2026, on branch `experiments-v3`, **before any model was run on any handbook case**.
This file is committed and pushed to GitHub before the first handbook run; the commit and the push
date are the record that the hypotheses, measures and tests below were fixed in advance. Every
analysis not listed here is exploratory and will be reported as such.

## 1. Why a second test set

The paper's results come from 207 visits (56 patients) of the MIMIC-IV-ED demo, with the triage
nurse's ESI level as the reference. They are the discovery set: the hypotheses below were
formed by looking at those results. The handbook cases are a second, independent set, with three
properties the MIMIC demo lacks: the reference levels are the ESI authors' expert answers, all
five levels occur, and every case is a different patient.

## 2. The case set (fixed)

- Source: Emergency Severity Index (ESI) Version 4 Implementation Handbook, 2012 edition (AHRQ
  Publication No. 12-0014), the 114-page PDF in `medical-pdf/originals/`. Chapter 9: 100 practice
  cases (PDF pages 77 to 84) with the official answers (pages 84 to 90). Chapter 10: two sets of
  25 competency cases, Set A and Set B (pages 91 to 94), with answers (pages 94 to 97).
- The task description named 125 cases (100 + 25). Chapter 10 holds 50 competency cases, and all
  150 were extracted. One case, CA007, is left out because its official answer gives two levels
  ("ESI level 4 or 5"). **The analysis set is the other 149 cases.**
- Official levels of the 149 cases: ESI 1: 23, ESI 2: 42, ESI 3: 41, ESI 4: 19, ESI 5: 24.
  Paediatric (under 18, or a child with no stated age): 32.
- Extraction: `research/handbook_cases.py`, output `data/esi_handbook_cases.json`
  (sha256 `530607f400f0f0702eda9412c2070323f63fcdad1cfa4c7164d7d2d43e682223`), in the schema of
  `data/mimic_ed_cohort.json`. The full vignette is the chief complaint; age, sex, every vital
  sign and pain score given as a number were also parsed into their fields. Every case was keyed
  by hand from the PDF text and compared with the parser: 0 differences in 150 cases
  (`research/results_ext/handbook_cases_check.md`).
- Overlap with the retrieval corpus (`medical-pdf/ingestion/index_v4/guidelines.metadata.jsonl`,
  pages 16 to 60 and 109 to 110 of the same handbook, plus the curated ESI guide): with
  50-character shingles, one vignette (P027) and one official answer (CB010) each share a single
  shingle, a generic phrase ("in a high-speed motor vehicle crash. the patient", "patient does not
  meet the criteria for esi level"). No case text is in the corpus
  (`research/results_ext/handbook_overlap_check.json`).
- Retrieval: built with the paper's method (dense bge-m3 + BM25, reciprocal rank fusion, top 20
  reranked by bge-reranker-v2-m3 at revision 953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e, top 5
  kept) into `research/results_ext/handbook/retrieval_cache_handbook.json`
  (sha256 `8d0cb86fac06ccf7b0d7c104b4a52a6a72f9c5da388c4546776364de3adb8fcc`). Every setup with
  retrieval on the handbook uses this file. Its settings match `research/retrieval_cache.v2.json`
  except that the reranker ran on the GPU (cuda) instead of the CPU; rebuilding the MIMIC cache
  the same way on this server gave the same top 5 passages, in the same order, for 206 of the 207
  visits, and 4 of 5 for the other (`research/results_ext/handbook/retrieval_cache_mimic_repro.json`).
  The embeddings came from bge-m3 in Ollama 0.32.14 on the CPU.

## 3. Runs (fixed)

Five models, the same builds and settings as the paper (Ollama 0.32.14, Q4_K_M, temperature 0,
seed 42, context 8,192; `research/results_ext/run_info.json`): qwen2.5:7b, llama3.1:8b, gemma3:12b,
gemma3:27b, medgemma:27b. Nine setups each, into `research/results_ext/handbook/`: LLM only;
+ safety; + safety, no notice (`--safety-notice=off`); + ESI guide; + ESI guide + safety; + RAG;
full (RAG + safety); guide + RAG; guide + RAG + safety. The runs the hypotheses need are run
first. Prompts are those of the paper; nothing about the prompt, the models or the rules is
changed for the handbook.

## 4. Hypotheses

All hypotheses are directional and tested one-sided. A "run" below means a model in a setup on
the 149 cases.

- **H1 (the reassuring notice).** In the safety setup, the line shown when no rule fires
  ("SAFETY ENGINE VERDICT: no critical red flags detected. Assess normally.") raises
  under-triage compared with the same rules without that line (`--safety-notice=off`).
  One test per model: H1a qwen2.5:7b, H1b gemma3:27b, H1c medgemma:27b.
  Comparison: + safety against + safety, no notice. Measure: under-triage.
- **H2 (retrieval).** Retrieval lowers under-triage compared with the model on its own.
  H2a qwen2.5:7b, H2b llama3.1:8b, H2c gemma3:12b. Comparison: LLM only against + RAG.
  Measure: under-triage.
- **H3 (the guide).** The ESI guide raises exact agreement for gemma3:12b.
  Comparison: LLM only against + ESI guide. Measure: exact agreement.
- **H4 (model size and medical training).** On their own (LLM only):
  - H4a: gemma3:27b has higher exact agreement than gemma3:12b;
  - H4b: medgemma:27b has higher exact agreement than gemma3:12b;
  - H4c: medgemma:27b does not have higher exact agreement than gemma3:27b.

## 5. Measures

Computed on the cases with a valid model answer (status `ok`) in both runs of a comparison;
the number of other cases is reported per run.

- **Under-triage:** the share of cases where the final ESI level (after any safety override) is
  higher, that is less urgent, than the official level.
- **Exact agreement:** the share of cases where the final ESI level equals the official level.

These two are the primary measures. Within one level, over-triage, severe under-triage,
quadratic-weighted kappa, sensitivity and specificity for ESI 1 to 2, and calibration are
reported as secondary, descriptive measures with 95% bootstrap confidence intervals over cases
(2,000 resamples, seed 42).

## 6. Test

Paired permutation test at the case level: the cases are independent (every case is a different
patient), so each case is its own unit. For each comparison, every case's difference between the
two runs (1 or 0 for the measure, run B minus run A in the hypothesised direction) keeps or flips
its sign at random, 20,000 times (Python `random.Random(42)`). The one-sided p value is
(number of permuted sums at least as large as the observed sum in the hypothesised direction
+ 1) / (20,000 + 1). Cases where the two runs agree contribute nothing. This is the exact
McNemar test approximated by permutation, and the same procedure as the paper's patient-level
test with one case per patient.

Multiple testing: Holm adjustment within each hypothesis family at alpha 0.05 (one-sided):
H1 (3 tests), H2 (3 tests), H3 (1 test), and H4a with H4b (2 tests). H4c claims the absence of an
effect, so adjusting it would make support easier; it is judged on its unadjusted one-sided p
value (medgemma:27b higher than gemma3:27b), and the difference with its 95% bootstrap
confidence interval is reported. A non-significant result is not evidence that two runs are
equal, and H4c will be described that way.

## 7. Decision rules

- H1a to H1c, H2a to H2c, H3, H4a and H4b: **supported** if the Holm-adjusted one-sided p value is
  below 0.05; **not supported** otherwise. If the observed difference goes in the opposite
  direction, this is stated, with the two-sided p value as an exploratory figure.
- H4c: **supported** if the unadjusted one-sided p value is 0.05 or more; **not supported** if
  it is below 0.05.
- A family as a whole is reported as supported if all its tests are supported, not supported if
  none is, and partly supported otherwise.
- **Inconclusive:** a test whose runs have valid answers for fewer than 142 of the 149 cases
  (95%), or a run that could not be completed. The reason will be given.

## 8. Exploratory (not confirmatory)

Everything else: the other setups and comparisons (guide + RAG, guide + safety, the full
pipeline, the two notice wordings of task 4), the secondary measures, results by level, by set
(practice or competency) and for children, the rules-only and "always ESI 2" baselines,
Gemma 3 27B against MedGemma 27B in the setups other than H4c, and any comparison with the MIMIC
results.

## 9. Known risks, stated in advance

- **Training data.** The ESI v4 handbook has been public since 2005 (first edition of version 4)
  and the 2012 edition since its publication; its cases and answers may be in the models'
  training data. Good results on these cases could partly reflect memorisation. This cannot be
  ruled out here.
- **Vignettes are not triage records.** They are written teaching cases, often stating the
  reasoning cues (for example "the patient is tiring") that a triage record would not hold, and
  the full text is given to the model as the chief complaint.
- **The safety rules were written for short complaint lists.** On these vignettes, matched as free
  text, they fire for 37 of the 149 cases, including cases where the matched word is negated
  ("denies loss of consciousness") and infants whose normal heart and breathing rates exceed
  the adult thresholds. The rules are not changed for the handbook, so these false alarms are
  part of the result.
- **The pipeline splits the chief complaint at commas** into a primary and secondary symptoms,
  so the vignette text appears twice in each prompt. This is how the unchanged pipeline treats
  any complaint and is not altered for the handbook.
- **Way of arrival** is not extracted (left empty); where the vignette names it, it is in the text.
- Prompts with retrieval or the guide are longer. The longest handbook prompts (guide + retrieval
  + safety) were counted before the runs: 4,136 and 4,216 tokens for qwen2.5:7b
  (`research/results_ext/handbook/prompt_tokens_handbook.jsonl`), within the 8,192-token window.

## 10. What happens next

1. This file is committed, and the user pushes branch `experiments-v3` to GitHub.
2. Only after the user confirms the push are the handbook runs started (`research/run_ext.sh`
   refuses handbook runs until then).
3. The analysis code (`research/analyze_ext.py`) implements sections 5 to 7 exactly. The results
   will be reported in `research/results_ext/REPORT.md`, confirmatory tests first and separately.
