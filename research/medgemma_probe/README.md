# Why medgemma:4b was excluded (30 Oct 2026)

The first medgemma:4b run (`--rag=off --safety=off`) never finished patient 1
(stay order of `data/mimic_ed_cohort.json`): Ollama generated 5,809 tokens for
the first attempt before the run was stopped, with no complete JSON. No result
file was written, so no medgemma results exist.

`request_case1.json` is that first attempt's request to Ollama `/api/chat`,
captured from `scripts/evaluate_mimic.ts`, with one change: `num_predict: 1200`
so the replay ends. `response_case1.json` is the replay: `done_reason: "length"`
after 1,200 tokens, and the `reasoning` string repeats "The patient's symptoms
are not life-threatening." 53 times. The same request sent to gemma3:12b
finished normally (429 tokens).

Replay: `curl -s localhost:11434/api/chat -d @research/medgemma_probe/request_case1.json`

The study keeps one decoding setup for every model (temperature 0, seed 42, no
repetition penalty), so medgemma was dropped rather than run with different
settings.
