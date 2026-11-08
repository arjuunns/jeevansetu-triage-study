import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

import { env, features } from '../config/env.js';
import { ServiceUnavailableError } from './errors.js';

export interface StructuredChatModel {
  invoke(input: any, options?: any): Promise<any>;
  withStructuredOutput(schema: any, config?: any): any;
}

let _chat: StructuredChatModel | null = null;
let _embeddings: { embedDocuments: (texts: string[]) => Promise<number[][]>; embedQuery: (text: string) => Promise<number[]> } | null = null;

export class ResilientChatModel implements StructuredChatModel {
  constructor(
    private readonly primary: ChatGoogleGenerativeAI,
    private readonly fallbacks: ChatGoogleGenerativeAI[],
  ) {}

  async invoke(input: any, options?: any): Promise<any> {
    const model = this.primary.withFallbacks({
      fallbacks: this.fallbacks,
    });
    return model.invoke(input, options);
  }

  withStructuredOutput(schema: any, config?: any): any {
    const primaryStructured = this.primary.withStructuredOutput(schema, config);
    const fallbackStructureds = this.fallbacks.map((f) =>
      f.withStructuredOutput(schema, config)
    );
    return primaryStructured.withFallbacks({
      fallbacks: fallbackStructureds,
    });
  }
}

/** Ollama Chat Client supporting direct REST and structured output. */
export class OllamaChatModel implements StructuredChatModel {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number = 0.1,
    private readonly seed?: number,
    private readonly numCtx: number = 8192,
  ) {}

  private get options(): { temperature: number; num_ctx: number; seed?: number } {
    const base = { temperature: this.temperature, num_ctx: this.numCtx };
    return this.seed === undefined ? base : { ...base, seed: this.seed };
  }

  async invoke(messages: any[], _options?: any): Promise<any> {
    const formattedMessages = (Array.isArray(messages) ? messages : [messages]).map((m) => {
      const role =
        typeof m._getType === 'function'
          ? m._getType() === 'system'
            ? 'system'
            : m._getType() === 'ai'
              ? 'assistant'
              : 'user'
          : m.role ?? 'user';
      return { role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    });

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: formattedMessages,
        stream: false,
        options: this.options,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ServiceUnavailableError(`Ollama (${res.status}): ${err}`);
    }

    const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return {
      content: data.message?.content ?? '',
      usage_metadata: {
        prompt_tokens: data.prompt_eval_count ?? 0,
        candidates_tokens: data.eval_count ?? 0,
        total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
    };
  }

  withStructuredOutput(schema: any, _config?: any): any {
    const jsonSchema = {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'] },
        esiLevel: { type: 'integer', minimum: 1, maximum: 5 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: { type: 'string' },
        possibleConditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              condition: { type: 'string' },
              likelihood: { type: 'string', enum: ['LOW', 'MODERATE', 'HIGH'] },
              icd10: { type: 'string' },
            },
            required: ['condition', 'likelihood'],
          },
        },
        recommendedDepartment: { type: 'string' },
        recommendedTests: { type: 'array', items: { type: 'string' } },
        riskFactors: { type: 'array', items: { type: 'string' } },
        redFlags: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'severity',
        'esiLevel',
        'confidence',
        'reasoning',
        'possibleConditions',
        'recommendedDepartment',
      ],
    };

    return {
      invoke: async (messages: any[]) => {
        const formattedMessages = (Array.isArray(messages) ? messages : [messages]).map((m) => {
          const role =
            typeof m._getType === 'function'
              ? m._getType() === 'system'
                ? 'system'
                : m._getType() === 'ai'
                  ? 'assistant'
                  : 'user'
              : m.role ?? 'user';
          return { role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
        });

        const jsonInstruction =
          '\nYou MUST respond ONLY with valid JSON strictly matching the schema: severity ("CRITICAL"|"HIGH"|"MODERATE"|"LOW"), esiLevel (integer 1-5), confidence (float 0.0-1.0), reasoning (string), possibleConditions (array of { condition: string, likelihood: "HIGH"|"MODERATE"|"LOW" }), recommendedDepartment (string), recommendedTests (string[]), riskFactors (string[]), redFlags (string[]).';

        if (formattedMessages.length > 0 && formattedMessages[0]?.role === 'system') {
          formattedMessages[0].content += jsonInstruction;
        } else {
          formattedMessages.unshift({ role: 'system', content: jsonInstruction });
        }

        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: formattedMessages,
            format: jsonSchema,
            stream: false,
            options: this.options,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new ServiceUnavailableError(`Ollama (${res.status}): ${err}`);
        }

        const data = (await res.json()) as { message?: { content?: string } };
        const content = data.message?.content ?? '{}';
        const cleaned = content.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
        let parsed: any;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          parsed = {};
        }

        if (parsed.triage_assessment && typeof parsed.triage_assessment === 'object') {
          parsed = parsed.triage_assessment;
        } else if (parsed.assessment && typeof parsed.assessment === 'object') {
          parsed = parsed.assessment;
        }

        const sanitized = sanitizeTriageOutput(parsed);
        return schema.parse(sanitized);
      },
    };
  }
}

function sanitizeTriageOutput(raw: any): any {
  if (!raw || typeof raw !== 'object') raw = {};

  let esi = raw.esiLevel ?? raw.esi_level ?? raw.esi ?? raw.acuity ?? raw.acuityLevel;
  if (typeof esi === 'string') esi = parseInt(esi, 10);
  const esiValid = typeof esi === 'number' && Number.isInteger(esi) && esi >= 1 && esi <= 5;

  let sev: string = String(raw.severity ?? raw.severityLevel ?? '').toUpperCase();
  const sevValid = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'].includes(sev);

  // Never invent an acuity: a silent default could under-triage a critical
  // patient. With neither field usable, schema validation fails and the engine
  // retries, then falls back to the labelled heuristic.
  const severityToEsi: Record<string, number> = { CRITICAL: 1, HIGH: 2, MODERATE: 3, LOW: 4 };
  if (!esiValid) esi = sevValid ? severityToEsi[sev] : undefined;
  if (!sevValid && esiValid) {
    sev = esi === 1 ? 'CRITICAL' : esi === 2 ? 'HIGH' : esi === 3 ? 'MODERATE' : 'LOW';
  }

  let conf = raw.confidence ?? 0.85;
  if (typeof conf === 'string') conf = parseFloat(conf);
  if (isNaN(conf)) conf = 0.85;
  if (conf > 10) conf = conf / 100;
  else if (conf > 1) conf = conf / 10;
  if (conf < 0 || conf > 1) conf = 0.85;

  let reasoning = (raw.reasoning ?? raw.clinicalReasoning ?? raw.explanation ?? raw.rationale ?? '').toString().trim();
  if (reasoning.length < 10) {
    reasoning = `Clinical assessment based on presenting vital signs, reported chief complaint, and triage acuity level ${esi}.`;
  }

  let dept = (raw.recommendedDepartment ?? raw.recommended_department ?? raw.department ?? '').toString().trim();
  if (!dept) {
    dept = esi === 1 ? 'Emergency Department (Resuscitation)' : esi === 2 ? 'Emergency' : 'General Medicine';
  }

  let conds = raw.possibleConditions ?? raw.possible_conditions ?? raw.conditions;
  if (!Array.isArray(conds) || conds.length === 0) {
    conds = [{ condition: 'Acute Medical Presentation', likelihood: 'MODERATE' }];
  } else {
    conds = conds.map((c: any) => {
      if (typeof c === 'string') return { condition: c, likelihood: 'MODERATE' };
      const name = c.condition ?? c.name ?? 'Undetermined condition';
      let lik = (c.likelihood ?? 'MODERATE').toString().toUpperCase();
      if (!['LOW', 'MODERATE', 'HIGH'].includes(lik)) lik = 'MODERATE';
      return { condition: name, likelihood: lik, icd10: c.icd10 };
    });
  }

  const toArray = (v: any) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const tests = toArray(raw.recommendedTests ?? raw.recommended_tests ?? raw.tests);
  const risks = toArray(raw.riskFactors ?? raw.risk_factors);
  const redFlags = toArray(raw.redFlags ?? raw.red_flags ?? raw.flags);

  return {
    severity: sev,
    esiLevel: esi,
    confidence: conf,
    reasoning,
    possibleConditions: conds,
    recommendedDepartment: dept,
    recommendedTests: tests,
    riskFactors: risks,
    redFlags,
  };
}

/** Ollama Embeddings Client */
class OllamaEmbeddingsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.embedQuery(text));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });
    if (!res.ok) {
      throw new ServiceUnavailableError(`Ollama embeddings (${res.status})`);
    }
    const data = (await res.json()) as { embedding: number[] };
    return normalize(data.embedding);
  }
}

export const EMBEDDING_DIMENSION = 1024;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiEmbeddings {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, 'RETRIEVAL_DOCUMENT');
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text], 'RETRIEVAL_QUERY');
    if (!vector) throw new ServiceUnavailableError('Gemini embeddings (empty response)');
    return vector;
  }

  private async embed(texts: string[], taskType: string): Promise<number[][]> {
    const url = `${GEMINI_API_BASE}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: EMBEDDING_DIMENSION,
        })),
      }),
    });
    if (!res.ok) {
      throw new ServiceUnavailableError(`Gemini embeddings (${res.status})`);
    }
    const data = (await res.json()) as { embeddings: { values: number[] }[] };
    return data.embeddings.map((e) => normalize(e.values));
  }
}

function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? values : values.map((v) => v / norm);
}

export function getChatModel(overrides?: { temperature?: number; model?: string }): StructuredChatModel {
  if (!features.ai) throw new ServiceUnavailableError('AI');

  if (env.LLM_PROVIDER === 'ollama') {
    const baseUrl = env.OLLAMA_BASE_URL.replace('host.docker.internal', 'localhost');
    return new OllamaChatModel(
      baseUrl,
      overrides?.model ?? env.OLLAMA_MODEL,
      overrides?.temperature ?? env.LLM_TEMPERATURE,
      env.LLM_SEED,
      env.OLLAMA_NUM_CTX,
    );
  }

  if (!_chat || overrides) {
    const primaryModelName = overrides?.model ?? env.GEMINI_TRIAGE_MODEL ?? 'gemini-3.5-flash-lite';
    
    // Fallback order: gemini-3.5-flash-lite, gemini-3.6-flash, gemini-flash-latest, gemini-flash-lite-latest
    const fallbackNames = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest']
      .filter((m) => m !== primaryModelName);

    const primary = new ChatGoogleGenerativeAI({
      apiKey: env.GEMINI_API_KEY,
      model: primaryModelName,
      temperature: overrides?.temperature ?? env.LLM_TEMPERATURE,
      maxRetries: 1,
    });

    const fallbacks = fallbackNames.map((modelName) => {
      return new ChatGoogleGenerativeAI({
        apiKey: env.GEMINI_API_KEY,
        model: modelName,
        temperature: overrides?.temperature ?? env.LLM_TEMPERATURE,
        maxRetries: 1,
      });
    });

    const resilientModel = new ResilientChatModel(primary, fallbacks);

    if (!overrides) {
      _chat = resilientModel;
    }
    return resilientModel;
  }
  return _chat;
}

export function getEmbeddings(): { embedDocuments: (texts: string[]) => Promise<number[][]>; embedQuery: (text: string) => Promise<number[]> } {
  if (!features.ai) throw new ServiceUnavailableError('AI');

  if (env.EMBEDDING_PROVIDER === 'ollama') {
    const baseUrl = env.OLLAMA_BASE_URL.replace('host.docker.internal', 'localhost');
    return new OllamaEmbeddingsClient(baseUrl, env.OLLAMA_EMBEDDING_MODEL);
  }

  if (!_embeddings) {
    _embeddings = new GeminiEmbeddings(env.GEMINI_API_KEY as string, env.GEMINI_EMBEDDING_MODEL);
  }
  return _embeddings;
}
