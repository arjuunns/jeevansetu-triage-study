import './load-env.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'node:util';

import {
  DEFAULT_COHORT,
  DEFAULT_RETRIEVAL_CACHE,
  REPO_ROOT,
  SAFETY_TIMESTAMP,
  loadCohort,
  toSafetyInput,
  toTriageContext,
} from './mimic_cohort.js';

/**
 * Ablation runner for the MIMIC-IV-ED cohort. One invocation = one condition,
 * written to research/results/<run>.json after every case. Re-running the same
 * command resumes: finished cases are kept, errored cases are retried.
 *
 *   pnpm mimic:eval --rules-only
 *   pnpm mimic:eval --model=llama3.1:8b --rag=off --safety=off
 *   pnpm mimic:eval --model=llama3.1:8b --rag=on  --safety=on --limit=5
 *   pnpm mimic:eval --model=llama3.1:8b --rag=off --safety=off --guide=on
 *   pnpm mimic:eval --model=llama3.1:8b --rag=off --safety=on  --safety-notice=off
 *
 * --safety-notice=off (exploratory, added after the first qwen runs): rules and
 * override as usual, but the prompt says nothing when no rule fires, instead of
 * "no critical red flags detected".
 *
 * Case status: "ok" (valid model output), "fallback" (model failed every
 * attempt, heuristic answered) or "error" (exception). Only "ok" cases count as
 * the model's predictions; the other two are reported, never silently dropped.
 */

const { values } = parseArgs({
  options: {
    'rules-only': { type: 'boolean', default: false },
    provider: { type: 'string', default: 'ollama' },
    model: { type: 'string' },
    rag: { type: 'string', default: 'on' },
    safety: { type: 'string', default: 'on' },
    guide: { type: 'string', default: 'off' },
    'safety-notice': { type: 'string', default: 'on' },
    temperature: { type: 'string', default: '0' },
    seed: { type: 'string', default: '42' },
    limit: { type: 'string' },
    dataset: { type: 'string', default: DEFAULT_COHORT },
    'retrieval-cache': { type: 'string', default: DEFAULT_RETRIEVAL_CACHE },
    out: { type: 'string' },
    fresh: { type: 'boolean', default: false },
  },
});

function onOff(name: 'rag' | 'safety' | 'guide' | 'safety-notice'): boolean {
  const v = values[name];
  if (v !== 'on' && v !== 'off') throw new Error(`--${name} must be "on" or "off", got "${v}"`);
  return v === 'on';
}

const rulesOnly = values['rules-only'];
const provider = values.provider as 'ollama' | 'gemini';
const model =
  values.model ?? (provider === 'ollama' ? process.env.OLLAMA_MODEL ?? 'llama3.1:8b' : process.env.GEMINI_TRIAGE_MODEL);
const useRag = !rulesOnly && onOff('rag');
const useSafety = rulesOnly || onOff('safety');
const useGuide = !rulesOnly && onOff('guide');
const safetyNotice = rulesOnly || onOff('safety-notice');
if (!safetyNotice && !useSafety) throw new Error('--safety-notice=off needs --safety=on');
const temperature = Number(values.temperature);
const seed = Number(values.seed);

// env.ts reads process.env at import time, so overrides go in before the engine loads.
process.env.LLM_PROVIDER = provider;
if (provider === 'ollama') process.env.OLLAMA_MODEL = model;
else process.env.GEMINI_TRIAGE_MODEL = model;
process.env.LLM_TEMPERATURE = String(temperature);
process.env.LLM_SEED = String(seed);

const { runSafetyScreen } = await import('../src/modules/safety/safety.engine.js');
const { runTriage, runRulesOnlyTriage } = await import('../src/modules/triage/triage.engine.js');
const { TRIAGE_SYSTEM_PROMPT } = await import('../src/modules/triage/triage.prompts.js');
const { ESI_ALGORITHM_GUIDE } = await import('../src/modules/triage/esi.guide.js');
const { env } = await import('../src/config/env.js');

type Status = 'ok' | 'fallback' | 'error';

interface CaseResult {
  stayId: string;
  groundTruthEsi: number;
  status: Status;
  /** Final ESI after safety reconciliation; null on error. */
  predictedEsi: number | null;
  /** ESI the model itself returned before any override; null for fallback, error and rules-only. */
  modelEsi: number | null;
  safetyTriggered: boolean;
  safetyRules: string[];
  safetyOverridden: boolean;
  retrievalBackend: string;
  citationCount: number;
  attempts: number;
  latencyMs: number;
  model: string;
  confidence: number | null;
  recommendedDepartment: string | null;
  reasoning: string | null;
  error?: string;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9.]+/g, '-');
const runName = rulesOnly
  ? 'rules-only'
  : `${slug(model ?? 'unknown')}__rag-${useRag ? 'on' : 'off'}__safety-${useSafety ? 'on' : 'off'}${useGuide ? '__guide-on' : ''}${safetyNotice ? '' : '__notice-off'}`;
const outPath = path.resolve(values.out ?? path.join(REPO_ROOT, 'research/results', `${runName}.json`));
const rel = (p: string) => path.relative(REPO_ROOT, path.resolve(p));

let cases = loadCohort(values.dataset);
if (values.limit) cases = cases.slice(0, Number(values.limit));

const config = {
  run: runName,
  mode: rulesOnly ? 'rules-only' : 'llm',
  provider: rulesOnly ? null : provider,
  model: rulesOnly ? null : model,
  useRag,
  useSafety,
  useGuide,
  // Only recorded when off, so configs of runs made before this flag still match on resume.
  ...(safetyNotice ? {} : { safetyNotice: false }),
  temperature: rulesOnly ? null : temperature,
  seed: rulesOnly ? null : seed,
  dataset: rel(values.dataset),
  retrievalCache: useRag ? rel(values['retrieval-cache']) : null,
  // Detects a rebuilt cache or edited guide so stale partial runs are not resumed.
  retrievalCacheCreatedAt: useRag ? readCacheCreatedAt() : null,
  esiGuideSha256: useGuide ? sha256(ESI_ALGORITHM_GUIDE) : null,
  systemPromptSha256: sha256(TRIAGE_SYSTEM_PROMPT),
};

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readCacheCreatedAt(): string | null {
  const file = values['retrieval-cache'];
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')).meta?.createdAt ?? null) : null;
}

async function preflight(): Promise<Record<string, { citations: any[]; backend: string }> | null> {
  if (!rulesOnly && provider === 'ollama') {
    const base = env.OLLAMA_BASE_URL.replace('host.docker.internal', 'localhost');
    const tags = await fetch(`${base}/api/tags`)
      .then((r) => r.json() as Promise<{ models?: { name: string }[] }>)
      .catch(() => null);
    if (!tags) throw new Error(`Ollama is not reachable at ${base}. Start it with: ollama serve`);
    const names = (tags.models ?? []).map((m) => m.name);
    if (!names.includes(model!) && !names.includes(`${model}:latest`)) {
      throw new Error(`Model "${model}" is not pulled. Run: ollama pull ${model}`);
    }
  }
  if (!useRag) return null;
  const cachePath = values['retrieval-cache'];
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Retrieval cache missing at ${rel(cachePath)}. Run: pnpm mimic:retrieval-cache`);
  }
  const entries = JSON.parse(fs.readFileSync(cachePath, 'utf-8')).entries;
  const missing = cases.filter((c) => !entries[c.stayId]);
  if (missing.length) throw new Error(`Retrieval cache lacks ${missing.length} cohort cases; rebuild it.`);
  return entries;
}

function loadPrevious(): CaseResult[] {
  if (values.fresh || !fs.existsSync(outPath)) return [];
  const prev = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  if (JSON.stringify(prev.config) !== JSON.stringify(config)) {
    throw new Error(`${rel(outPath)} was produced with a different config. Re-run with --fresh to overwrite.`);
  }
  return (prev.results as CaseResult[]).filter((r) => r.status !== 'error');
}

function save(results: CaseResult[], startedAt: string): void {
  const counts = { total: cases.length, done: results.length, ok: 0, fallback: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  const payload = {
    config,
    startedAt,
    updatedAt: new Date().toISOString(),
    complete: results.length === cases.length,
    counts,
    results,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(`${outPath}.tmp`, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(`${outPath}.tmp`, outPath);
}

async function main(): Promise<void> {
  const retrieval = await preflight();
  const previous = loadPrevious();
  const done = new Set(previous.map((r) => r.stayId));
  const byStay = new Map(previous.map((r) => [r.stayId, r]));
  const startedAt = new Date().toISOString();

  console.log(`\nRun: ${runName}  (${cases.length} cases, ${done.size} already done)`);
  console.log(`Output: ${rel(outPath)}\n`);

  for (const [i, c] of cases.entries()) {
    if (done.has(c.stayId)) continue;

    const safety = runSafetyScreen(toSafetyInput(c.input), SAFETY_TIMESTAMP);
    const ctx = toTriageContext(c.input, safety);
    const base = {
      stayId: c.stayId,
      groundTruthEsi: c.label.esi,
      safetyTriggered: safety.isCritical,
      safetyRules: safety.triggeredRules.map((r) => r.ruleId),
    };

    let record: CaseResult;
    const t0 = Date.now();
    if (rulesOnly) {
      const r = runRulesOnlyTriage(ctx);
      record = {
        ...base,
        status: 'ok',
        predictedEsi: r.esiLevel,
        modelEsi: null,
        safetyOverridden: false,
        retrievalBackend: 'disabled',
        citationCount: 0,
        attempts: 0,
        latencyMs: 0,
        model: 'rules-only',
        confidence: null,
        recommendedDepartment: r.recommendedDepartment,
        reasoning: r.reasoning,
      };
    } else {
      try {
        const out = await runTriage(ctx, {
          useSafety,
          safetyNotice,
          useRag,
          useAlgorithmGuide: useGuide,
          citations: retrieval?.[c.stayId]?.citations,
        });
        record = {
          ...base,
          status: out.usedFallback ? 'fallback' : 'ok',
          predictedEsi: out.result.esiLevel,
          modelEsi: out.modelEsiLevel,
          safetyOverridden: out.safetyOverridden,
          retrievalBackend: useRag ? retrieval![c.stayId]!.backend : out.retrievalBackend,
          citationCount: out.citations.length,
          attempts: out.attempts,
          latencyMs: Date.now() - t0,
          model: out.model,
          confidence: out.result.confidence,
          recommendedDepartment: out.result.recommendedDepartment,
          reasoning: out.reasoningText,
        };
      } catch (err) {
        record = {
          ...base,
          status: 'error',
          predictedEsi: null,
          modelEsi: null,
          safetyOverridden: false,
          retrievalBackend: useRag ? 'precomputed' : 'disabled',
          citationCount: 0,
          attempts: 0,
          latencyMs: Date.now() - t0,
          model: model ?? 'unknown',
          confidence: null,
          recommendedDepartment: null,
          reasoning: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    byStay.set(c.stayId, record);
    save(
      cases.flatMap((x) => byStay.get(x.stayId) ?? []),
      startedAt,
    );

    const tag =
      record.status !== 'ok'
        ? record.status.toUpperCase()
        : record.predictedEsi === c.label.esi
          ? 'exact'
          : record.predictedEsi! > c.label.esi
            ? 'UNDER'
            : 'over';
    console.log(
      `[${String(i + 1).padStart(3)}/${cases.length}] true ${c.label.esi} pred ${record.predictedEsi ?? '-'} ${tag.padEnd(8)} ${String(record.latencyMs).padStart(6)}ms  ${c.input.chiefComplaint.slice(0, 40)}`,
    );
  }

  const results = cases.flatMap((x) => byStay.get(x.stayId) ?? []);
  const ok = results.filter((r) => r.status === 'ok');
  const pct = (n: number) => (ok.length ? ((100 * n) / ok.length).toFixed(1) : 'n/a');
  console.log(`\n${runName}: ${ok.length} ok, ${results.filter((r) => r.status === 'fallback').length} fallback, ${results.filter((r) => r.status === 'error').length} error`);
  console.log(`  exact ${pct(ok.filter((r) => r.predictedEsi === r.groundTruthEsi).length)}%`);
  console.log(`  within 1 ${pct(ok.filter((r) => Math.abs(r.predictedEsi! - r.groundTruthEsi) <= 1).length)}%`);
  console.log(`  under-triage ${pct(ok.filter((r) => r.predictedEsi! > r.groundTruthEsi).length)}%`);
  console.log(`  over-triage ${pct(ok.filter((r) => r.predictedEsi! < r.groundTruthEsi).length)}%`);
  console.log('Full statistics: python3 -I research/analyze.py\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
