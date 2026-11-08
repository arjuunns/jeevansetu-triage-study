import { z } from 'zod';

/**
 * Environment validation (Phase 1). The server refuses to boot if required
 * configuration is missing or malformed, so misconfiguration fails fast and
 * loudly rather than at the first request.
 *
 * Integrations that require third-party credentials (Gemini, Pinecone, Neo4j,
 * Clerk, AWS, notifications) are optional at the schema level and individually
 * guarded at their call sites — this lets the core platform (intake, safety,
 * audit) run locally without every external account provisioned.
 */
const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // AI provider ('gemini' | 'ollama')
  LLM_PROVIDER: z.enum(['gemini', 'ollama']).default('gemini'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  LLM_SEED: z.coerce.number().int().optional(),
  // Query embeddings must come from the model that built the Pinecone index
  // (gemini-embedding-001 @ 1024 dims), independent of the chat provider.
  EMBEDDING_PROVIDER: z.enum(['gemini', 'ollama']).default('gemini'),

  // Gemini AI stack
  GEMINI_API_KEY: z.string().default('DUMMY_GEMINI_KEY'),
  GEMINI_TRIAGE_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),

  // Ollama local AI stack
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1:8b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),
  // Ollama silently truncates prompts beyond the context window, so set it explicitly.
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(8192),

  // RAG
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX: z.string().default('jeevansetu-guidelines'),

  // Routing graph
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('jeevansetu'),

  // Auth
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // Storage
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_S3_BUCKET: z.string().default('jeevansetu-documents'),

  // Notifications
  RESEND_API_KEY: z.string().optional(),
  NOTIFICATION_FROM_EMAIL: z.string().default('alerts@jeevansetu.health'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  // Observability
  SENTRY_DSN: z.string().optional(),

  // Allow auth to be bypassed ONLY in local/dev for testing intake flows.
  AUTH_DISABLED: booleanish.default('false'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

const isConfigured = (val?: string): boolean =>
  Boolean(val && !val.includes('your_') && !val.includes('dummy') && val !== 'DUMMY_GEMINI_KEY');

/** Feature flags derived from which credentials are present. */
export const features = {
  ai: env.LLM_PROVIDER === 'ollama' || isConfigured(env.GEMINI_API_KEY),
  rag:
    (env.EMBEDDING_PROVIDER === 'ollama' || isConfigured(env.GEMINI_API_KEY)) && isConfigured(env.PINECONE_API_KEY),
  auth: isConfigured(env.CLERK_SECRET_KEY) && isConfigured(env.CLERK_PUBLISHABLE_KEY) && !env.AUTH_DISABLED,
  storage: isConfigured(env.AWS_ACCESS_KEY_ID) && isConfigured(env.AWS_SECRET_ACCESS_KEY),
  email: isConfigured(env.RESEND_API_KEY),
  sms: isConfigured(env.TWILIO_ACCOUNT_SID) && isConfigured(env.TWILIO_AUTH_TOKEN),
} as const;
