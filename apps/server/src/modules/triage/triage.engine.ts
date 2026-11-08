import {
  triageResultSchema,
  type GuidelineCitation,
  type SeverityLevel,
  type TriageResult,
} from '@jeevansetu/types';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getChatModel } from '../../lib/ai.js';
import { logGenAiUsage } from '../../lib/genaiLogger.js';
import { describeAbnormalVitals, expandClinicalAbbreviations } from '../rag/query.js';
import { retrieveGuidelinesWithMeta, type RetrievalBackend } from '../rag/rag.service.js';

import {
  buildTriageUserPrompt,
  TRIAGE_SYSTEM_PROMPT,
  type TriageContext,
} from './triage.prompts.js';

/**
 * Phase 6 — AI Triage Engine (LangGraph workflow).
 *
 * Graph:  retrieve(guidelines) → assess(LLM, structured + retry) → reconcile(safety override)
 *
 * Guarantees:
 *  • Structured JSON output enforced via Zod-bound structured output.
 *  • Up to MAX_ATTEMPTS retries on validation failure (hallucination guard).
 *  • The deterministic safety verdict is applied AFTER the model, never below
 *    CRITICAL — the model can never downgrade a safety-flagged patient.
 *  • If Gemini is not configured the engine returns a deterministic, clearly
 *    labelled heuristic baseline so the pipeline still produces a reviewable
 *    assessment for the doctor.
 */

const MAX_ATTEMPTS = 3;

/**
 * Switches used by the research ablation. Production callers pass nothing and
 * get the full pipeline (safety + RAG).
 */
export interface TriageRunOptions {
  /** Show the safety verdict to the model and enforce it afterwards. Default true. */
  useSafety?: boolean;
  /** With safety on, tell the model when no rule fired. Default true; false keeps the prompt silent unless a rule fires. */
  safetyNotice?: boolean;
  /** Include retrieved guideline excerpts. Default true. */
  useRag?: boolean;
  /** Include the full curated ESI algorithm summary in the prompt. Default false. */
  useAlgorithmGuide?: boolean;
  /** Precomputed citations to use instead of live retrieval, so retrieval is identical across runs. */
  citations?: GuidelineCitation[];
}

type ResolvedOptions = Required<Pick<TriageRunOptions, 'useSafety' | 'safetyNotice' | 'useRag' | 'useAlgorithmGuide'>> &
  Pick<TriageRunOptions, 'citations'>;

export interface TriageEngineResult {
  result: TriageResult;
  citations: GuidelineCitation[];
  reasoningText: string;
  rawOutput: unknown;
  model: string;
  attempts: number;
  usedFallback: boolean;
  /** ESI the model returned before safety reconciliation; null when the fallback answered. */
  modelEsiLevel: number | null;
  safetyOverridden: boolean;
  retrievalBackend: RetrievalBackend | 'precomputed' | 'disabled';
}

const TriageState = Annotation.Root({
  context: Annotation<TriageContext>(),
  options: Annotation<ResolvedOptions>(),
  citations: Annotation<GuidelineCitation[]>({ reducer: (_p, n) => n, default: () => [] }),
  retrievalBackend: Annotation<TriageEngineResult['retrievalBackend']>({ reducer: (_p, n) => n, default: () => 'none' }),
  result: Annotation<TriageResult | null>({ reducer: (_p, n) => n, default: () => null }),
  modelEsiLevel: Annotation<number | null>({ reducer: (_p, n) => n, default: () => null }),
  safetyOverridden: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  attempts: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  rawOutput: Annotation<unknown>({ reducer: (_p, n) => n, default: () => null }),
  usedFallback: Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
});

type State = typeof TriageState.State;

function activeModelName(): string {
  return env.LLM_PROVIDER === 'ollama' ? env.OLLAMA_MODEL : env.GEMINI_TRIAGE_MODEL;
}

/**
 * The text sent to the guideline retriever: age, sex, the presenting problem
 * with abbreviations expanded, and abnormal vital signs named in words.
 */
export function buildRetrievalQuery(ctx: TriageContext): string {
  const parts: string[] = [];
  for (const part of [ctx.chiefComplaint, ctx.primarySymptom, ...ctx.secondarySymptoms]) {
    const text = part?.trim();
    if (text && !parts.some((p) => p.toLowerCase().includes(text.toLowerCase()))) parts.push(text);
  }
  const complaint = expandClinicalAbbreviations(parts.join(', '));
  const findings = describeAbnormalVitals(ctx.vitals, ctx.patient.age);
  const patient = `${ctx.patient.age}-year-old ${ctx.patient.gender.toLowerCase()} presenting with ${complaint}`;
  return findings.length ? `${patient}. Findings: ${findings.join(', ')}.` : `${patient}.`;
}

async function retrieveNode(state: State): Promise<Partial<State>> {
  const { useRag, citations } = state.options;
  if (!useRag) return { citations: [], retrievalBackend: 'disabled' };
  if (citations) return { citations, retrievalBackend: 'precomputed' };
  const retrieved = await retrieveGuidelinesWithMeta(buildRetrievalQuery(state.context), 5);
  return { citations: retrieved.citations, retrievalBackend: retrieved.backend };
}

async function assessNode(state: State): Promise<Partial<State>> {
  const { useSafety, safetyNotice, useRag, useAlgorithmGuide } = state.options;
  if (!features.ai) {
    return { result: heuristicAssessment(state.context, useSafety), usedFallback: true, attempts: 0 };
  }

  const model = getChatModel().withStructuredOutput(triageResultSchema, { name: 'triage_assessment' });
  const messages = [
    new SystemMessage(TRIAGE_SYSTEM_PROMPT),
    new HumanMessage(
      buildTriageUserPrompt(state.context, state.citations, {
        safety: useSafety,
        safetyNotice,
        guidelines: useRag,
        algorithm: useAlgorithmGuide,
      }),
    ),
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startTime = Date.now();
    try {
      const raw = await model.invoke(messages);
      const latencyMs = Date.now() - startTime;
      const usage = (raw as any)?.usage_metadata || (raw as any)?.response_metadata?.tokenUsage;

      logGenAiUsage({
        feature: 'TRIAGE',
        model: activeModelName(),
        latencyMs,
        status: 'SUCCESS',
        promptTokens: usage?.prompt_tokens || usage?.input_tokens || usage?.inputTokens || 0,
        responseTokens: usage?.candidates_tokens || usage?.output_tokens || usage?.outputTokens || 0,
        totalTokens: usage?.total_tokens || usage?.totalTokens || 0,
      });

      // Structured output already conforms, but we re-validate defensively.
      const parsed = triageResultSchema.parse(raw);
      return { result: parsed, modelEsiLevel: parsed.esiLevel, rawOutput: raw, attempts: attempt, usedFallback: false };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      logGenAiUsage({
        feature: 'TRIAGE',
        model: activeModelName(),
        latencyMs,
        status: 'FAILED',
        errorMessage: err.message || String(err),
      });

      lastError = err;
      logger.warn({ err, attempt }, 'Triage assessment attempt failed; retrying');
      messages.push(
        new HumanMessage(
          'Your previous response did not conform to the required schema. Return ONLY a valid structured triage assessment.',
        ),
      );
    }
  }

  logger.error({ err: lastError }, 'Triage AI failed after retries — using heuristic fallback');
  return { result: heuristicAssessment(state.context, useSafety), usedFallback: true, attempts: MAX_ATTEMPTS };
}

/**
 * Reconcile the model's severity with the deterministic safety verdict. Rules
 * always override AI: a safety-critical patient is forced to CRITICAL/ESI 1.
 */
function reconcileNode(state: State): Partial<State> {
  const result = state.result;
  if (!result || !state.options.useSafety) return {};
  if (state.context.safety.isCritical && (result.severity !== 'CRITICAL' || result.esiLevel !== 1)) {
    const forced: TriageResult = {
      ...result,
      severity: 'CRITICAL',
      esiLevel: 1,
      reasoning: `[SAFETY OVERRIDE] Deterministic safety rules (${state.context.safety.triggeredRules
        .map((r) => r.label)
        .join('; ')}) force CRITICAL severity. Original model reasoning: ${result.reasoning}`,
      redFlags: dedupe([...result.redFlags, ...state.context.safety.triggeredRules.map((r) => r.label)]),
    };
    return { result: forced, safetyOverridden: true };
  }
  return {};
}

const graph = new StateGraph(TriageState)
  .addNode('retrieve', retrieveNode)
  .addNode('assess', assessNode)
  .addNode('reconcile', reconcileNode)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'assess')
  .addEdge('assess', 'reconcile')
  .addEdge('reconcile', END)
  .compile();

export async function runTriage(context: TriageContext, options: TriageRunOptions = {}): Promise<TriageEngineResult> {
  const resolved: ResolvedOptions = {
    useSafety: options.useSafety ?? true,
    safetyNotice: options.safetyNotice ?? true,
    useRag: options.useRag ?? true,
    useAlgorithmGuide: options.useAlgorithmGuide ?? false,
    citations: options.citations,
  };
  const final = await graph.invoke({ context, options: resolved });
  const result = final.result ?? heuristicAssessment(context, resolved.useSafety);
  return {
    result,
    citations: final.citations,
    reasoningText: result.reasoning,
    rawOutput: final.rawOutput,
    model: final.usedFallback ? 'deterministic-fallback' : activeModelName(),
    attempts: final.attempts,
    usedFallback: final.usedFallback,
    modelEsiLevel: final.usedFallback ? null : final.modelEsiLevel,
    safetyOverridden: final.safetyOverridden,
    retrievalBackend: final.retrievalBackend,
  };
}

/** Rules-only baseline (safety engine + vital-sign heuristic), no LLM. */
export function runRulesOnlyTriage(context: TriageContext): TriageResult {
  return heuristicAssessment(context, true);
}

// ── Deterministic fallback ─────────────────────────────────────────────────────
// Not a placeholder: a transparent, rule-based baseline that keeps the human
// review loop functional when the LLM is unavailable. Clearly labelled as such.

function heuristicAssessment(ctx: TriageContext, useSafety: boolean): TriageResult {
  const critical = useSafety && ctx.safety.isCritical;
  const severity: SeverityLevel = critical ? 'CRITICAL' : deriveHeuristicSeverity(ctx);
  const esiLevel = severity === 'CRITICAL' ? 1 : severity === 'HIGH' ? 2 : severity === 'MODERATE' ? 3 : 4;

  return {
    severity,
    esiLevel,
    confidence: 0.4,
    reasoning: critical
      ? `[HEURISTIC FALLBACK] Safety engine flagged CRITICAL via: ${ctx.safety.triggeredRules
          .map((r) => r.label)
          .join('; ')}. AI model unavailable; doctor review required.`
      : `[HEURISTIC FALLBACK] AI model unavailable. Severity derived from vital-sign thresholds and the presenting complaint. Treat as provisional pending doctor review.`,
    possibleConditions: [{ condition: 'Undetermined — clinical correlation required', likelihood: 'MODERATE' }],
    recommendedDepartment: critical ? 'Emergency' : 'General Medicine',
    recommendedTests: [],
    riskFactors: ctx.patient.existingDiseases ?? [],
    redFlags: critical ? ctx.safety.triggeredRules.map((r) => r.label) : [],
  };
}

function deriveHeuristicSeverity(ctx: TriageContext): SeverityLevel {
  const v = ctx.vitals;
  const spo2 = num(v.oxygenSaturation);
  const hr = num(v.heartRate);
  const sbp = num(v.systolicBp);
  if ((spo2 !== null && spo2 < 94) || (hr !== null && (hr > 120 || hr < 50)) || (sbp !== null && sbp < 100)) {
    return 'HIGH';
  }
  if (ctx.primarySymptom.toLowerCase().includes('pain')) return 'MODERATE';
  return 'LOW';
}

function num(v: number | boolean | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
