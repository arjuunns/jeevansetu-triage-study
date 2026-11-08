import './load-env.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'node:util';

import type { GuidelineCitation } from '@jeevansetu/types';

import { env } from '../src/config/env.js';
import { getEmbeddings } from '../src/lib/ai.js';
import { runSafetyScreen } from '../src/modules/safety/safety.engine.js';
import { ESI_GUIDE_SOURCE, esiGuideChunks } from '../src/modules/triage/esi.guide.js';
import { buildRetrievalQuery } from '../src/modules/triage/triage.engine.js';
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
 * Retrieve guideline excerpts once per cohort case and save them, so every
 * model and condition sees identical retrieval and the runs need no network.
 *
 *   pnpm mimic:retrieval-cache [--rerank=off] [--embedding=gemini]
 *
 * Pipeline (no evaluation labels are used anywhere):
 *   1. Corpus: chunks from medical-pdf/ingestion (minus excluded sources) plus
 *      the curated ESI algorithm summary as paragraph-level chunks.
 *   2. Query: buildRetrievalQuery (age, sex, expanded complaint, abnormal vitals).
 *   3. Hybrid candidates: dense cosine (bge-m3 via Ollama by default) and BM25,
 *      fused with reciprocal rank fusion; top 20 kept.
 *   4. Rerank: an LLM picks the 5 passages most useful for assigning an ESI
 *      level. Falls back to fusion order if the reranker fails (recorded).
 *   5. Each excerpt carries the full chunk text (up to 2000 characters).
 */

const TOP_K = 5;
const CANDIDATES = 20;
const FUSION_DEPTH = 50;
const RRF_K = 60;
const MAX_EXCERPT_CHARS = 2000;
const RERANK_PASSAGE_CHARS = 1200;
const DEFAULT_CORPUS = path.join(REPO_ROOT, 'medical-pdf/ingestion/index/guidelines.metadata.jsonl');
// A glossary carries no triage guidance but matches short queries well enough to
// crowd out real excerpts, so it is excluded (decided before any RAG results were seen).
const DEFAULT_EXCLUDE = 'Abbreviations-List.pdf';

const { values } = parseArgs({
  options: {
    corpus: { type: 'string', default: DEFAULT_CORPUS },
    exclude: { type: 'string', default: DEFAULT_EXCLUDE },
    // Local by default: no API quota, and retrieval runs on the same machine as the triage model.
    embedding: { type: 'string', default: 'ollama' },
    'embedding-model': { type: 'string', default: 'bge-m3' },
    rerank: { type: 'string', default: 'on' },
    'rerank-model': { type: 'string', default: 'gemini-3.5-flash-lite' },
    dataset: { type: 'string', default: DEFAULT_COHORT },
    out: { type: 'string', default: DEFAULT_RETRIEVAL_CACHE },
  },
});

const excludedSources = values.exclude
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface CorpusChunk {
  id: string;
  content: string;
  source_document: string;
  page_number?: number;
  section_title?: string;
}

/** Free-tier Gemini quotas are per minute, so back off up to a full window. */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 8) throw err;
      const waitMs = Math.min(65_000, 5000 * 2 ** (attempt - 1));
      console.warn(`  ${label} failed (${err instanceof Error ? err.message : err}); retrying in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

interface Embedder {
  name: string;
  documents(texts: string[]): Promise<number[][]>;
  query(text: string): Promise<number[]>;
}

function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Local embeddings through Ollama's batch endpoint; symmetric model, no task prefixes. */
function ollamaEmbedder(model: string): Embedder {
  const base = env.OLLAMA_BASE_URL.replace('host.docker.internal', 'localhost');
  const embed = async (input: string[]) => {
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) throw new Error(`Ollama embed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings.map(l2normalize);
  };
  return { name: `${model} (Ollama)`, documents: embed, query: async (t) => (await embed([t]))[0]! };
}

function geminiEmbedder(): Embedder {
  if (env.EMBEDDING_PROVIDER !== 'gemini') throw new Error('Set EMBEDDING_PROVIDER=gemini for Gemini embeddings.');
  const api = getEmbeddings();
  return {
    name: `${env.GEMINI_EMBEDDING_MODEL} (1024 dims)`,
    documents: (texts) => api.embedDocuments(texts),
    query: (text) => api.embedQuery(text),
  };
}

/**
 * Embeddings are deterministic for a given model, task and text, so they are
 * cached on disk; rebuilds only embed text not seen before.
 */
function cachedEmbedder(inner: Embedder): Embedder {
  const file = path.join(REPO_ROOT, 'research/.embedding_cache.json');
  const store: Record<string, number[]> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  const key = (task: string, text: string) => `${inner.name}|${task}|${crypto.createHash('sha1').update(text).digest('hex')}`;
  const save = () => fs.writeFileSync(file, JSON.stringify(store));

  return {
    name: inner.name,
    async documents(texts) {
      const missing = [...new Set(texts.filter((t) => !store[key('doc', t)]))];
      for (let i = 0; i < missing.length; i += 10) {
        const batch = missing.slice(i, i + 10);
        const vecs = await withRetry(() => inner.documents(batch), `chunk batch ${i}`);
        batch.forEach((t, j) => (store[key('doc', t)] = vecs[j]!));
        save();
      }
      return texts.map((t) => store[key('doc', t)]!);
    },
    async query(text) {
      const k = key('query', text);
      if (!store[k]) {
        store[k] = await withRetry(() => inner.query(text), 'query embedding');
        save();
      }
      return store[k]!;
    },
  };
}

function loadCorpus(): CorpusChunk[] {
  const pdfChunks = fs
    .readFileSync(values.corpus, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CorpusChunk)
    .filter((c) => !excludedSources.includes(c.source_document));
  const curated = esiGuideChunks().map((s, i) => ({
    id: `curated-esi-${i + 1}`,
    content: s.content,
    source_document: ESI_GUIDE_SOURCE,
    section_title: s.title,
  }));
  return [...pdfChunks, ...curated];
}

// ── BM25 ─────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was were will with without'.split(' '),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function bm25Scorer(docs: string[], k1 = 1.5, b = 0.75): (query: string) => number[] {
  const tokenized = docs.map(tokenize);
  const avgLen = tokenized.reduce((s, d) => s + d.length, 0) / tokenized.length;
  const docFreq = new Map<string, number>();
  const termFreqs = tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    return tf;
  });
  const n = docs.length;
  return (query) => {
    const terms = [...new Set(tokenize(query))];
    return termFreqs.map((tf, i) => {
      let score = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const df = docFreq.get(t)!;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokenized[i]!.length) / avgLen));
      }
      return score;
    });
  };
}

/** Indices sorted by descending score, keeping only positive scores when asked. */
function ranked(scores: number[], positiveOnly = false): number[] {
  return scores
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !positiveOnly || s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ i }) => i);
}

// ── LLM reranker ─────────────────────────────────────────────────────────────

async function rerankWithGemini(query: string, candidates: CorpusChunk[]): Promise<number[]> {
  const passages = candidates
    .map((c, i) => `[${i + 1}] (${c.source_document}${c.section_title ? `, ${c.section_title}` : ''})\n${c.content.slice(0, RERANK_PASSAGE_CHARS)}`)
    .join('\n\n');
  const prompt = `You are helping an emergency department triage nurse assign an Emergency Severity Index (ESI) level.

PATIENT
${query}

Below are ${candidates.length} numbered guideline passages. Choose the ${TOP_K} passages most useful for deciding this patient's ESI level: for example criteria for life-saving interventions, high-risk presentations relevant to this complaint, danger-zone vital signs, or expected resource needs. Passages that only describe treatment steps are less useful unless they bear on urgency.

Return JSON {"ranking": [...]} listing exactly ${TOP_K} passage numbers, most useful first.

${passages}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${values['rerank-model']}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { ranking: { type: 'ARRAY', items: { type: 'INTEGER' } } },
            required: ['ranking'],
          },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini rerank (${res.status})`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const ranking = (JSON.parse(text) as { ranking?: unknown[] }).ranking ?? [];
  const picked = [
    ...new Set(ranking.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= candidates.length)),
  ].map((n) => n - 1);
  if (picked.length === 0) throw new Error('Gemini rerank returned no usable ranking');
  return picked;
}

// ── main ─────────────────────────────────────────────────────────────────────

function toCitation(c: CorpusChunk, score: number): GuidelineCitation {
  return {
    guidelineId: c.source_document,
    source: c.page_number ? `${c.source_document}, p. ${c.page_number}` : c.source_document,
    title: c.section_title || c.source_document,
    chunkId: c.id,
    snippet: c.content.slice(0, MAX_EXCERPT_CHARS),
    page: c.page_number,
    score: Math.max(0, Math.min(1, score)),
  };
}

async function main(): Promise<void> {
  if (values.rerank !== 'on' && values.rerank !== 'off') throw new Error('--rerank must be "on" or "off"');
  if (values.embedding !== 'ollama' && values.embedding !== 'gemini') throw new Error('--embedding must be "ollama" or "gemini"');
  const useRerank = values.rerank === 'on';
  const cases = loadCohort(values.dataset);
  const chunks = loadCorpus();
  const embed = cachedEmbedder(values.embedding === 'ollama' ? ollamaEmbedder(values['embedding-model']) : geminiEmbedder());
  const bm25 = bm25Scorer(chunks.map((c) => `${c.section_title ?? ''} ${c.content}`));

  console.log(`Embedding ${chunks.length} chunks (${excludedSources.join(', ') || 'nothing'} excluded)...`);
  const vectors = await embed.documents(chunks.map((c) => c.content));

  const entries: Record<string, unknown> = {};
  let rerankFallbacks = 0;
  console.log(`Retrieving for ${cases.length} cases (hybrid${useRerank ? ` + ${values['rerank-model']} rerank` : ''})`);

  for (const [i, c] of cases.entries()) {
    const ctx = toTriageContext(c.input, runSafetyScreen(toSafetyInput(c.input), SAFETY_TIMESTAMP));
    const query = buildRetrievalQuery(ctx);

    // Vectors are L2-normalised, so the dot product is cosine similarity.
    const q = await embed.query(query);
    const dense = vectors.map((v) => v.reduce((sum, x, k) => sum + x * q[k]!, 0));
    const denseRank = ranked(dense).slice(0, FUSION_DEPTH);
    const bm25Rank = ranked(bm25(query), true).slice(0, FUSION_DEPTH);

    const fused = new Map<number, number>();
    for (const list of [denseRank, bm25Rank]) {
      list.forEach((doc, r) => fused.set(doc, (fused.get(doc) ?? 0) + 1 / (RRF_K + r + 1)));
    }
    const candidates = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CANDIDATES)
      .map(([doc]) => doc);

    let order = candidates.map((_, k) => k);
    let reranker = 'none';
    if (useRerank) {
      try {
        const picked = await withRetry(() => rerankWithGemini(query, candidates.map((d) => chunks[d]!)), 'rerank');
        order = [...picked, ...order.filter((k) => !picked.includes(k))];
        reranker = values['rerank-model'];
      } catch (err) {
        rerankFallbacks++;
        reranker = 'fallback-fusion-order';
        console.warn(`  rerank failed for stay ${c.stayId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const top = order.slice(0, TOP_K).map((k) => candidates[k]!);
    entries[c.stayId] = {
      query,
      backend: 'local-hybrid',
      reranker,
      citations: top.map((d) => toCitation(chunks[d]!, dense[d]!)),
      candidates: candidates.map((d) => ({
        chunkId: chunks[d]!.id,
        denseRank: denseRank.indexOf(d) + 1 || null,
        bm25Rank: bm25Rank.indexOf(d) + 1 || null,
      })),
    };
    if ((i + 1) % 25 === 0 || i + 1 === cases.length) console.log(`  ${i + 1}/${cases.length}`);
  }

  const sources: Record<string, number> = {};
  for (const e of Object.values(entries) as { citations: GuidelineCitation[] }[]) {
    for (const cit of e.citations) sources[cit.guidelineId] = (sources[cit.guidelineId] ?? 0) + 1;
  }

  const out = path.resolve(values.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        meta: {
          createdAt: new Date().toISOString(),
          dataset: path.relative(REPO_ROOT, path.resolve(values.dataset)),
          corpus: path.relative(REPO_ROOT, path.resolve(values.corpus)),
          excludedSources,
          curatedChunks: esiGuideChunks().length,
          corpusChunks: chunks.length,
          embeddingModel: embed.name,
          method: `dense + BM25, reciprocal rank fusion (k=${RRF_K}, depth ${FUSION_DEPTH}), top ${CANDIDATES} candidates${useRerank ? `, reranked by ${values['rerank-model']}` : ''}, top ${TOP_K} kept`,
          maxExcerptChars: MAX_EXCERPT_CHARS,
          rerankFallbacks,
          retrievedSources: sources,
        },
        entries,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nWrote ${path.relative(REPO_ROOT, out)}  sources: ${JSON.stringify(sources)}  rerank fallbacks: ${rerankFallbacks}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Retrieval cache build failed:', err);
  process.exit(1);
});
