import fs from 'node:fs';
import path from 'node:path';

export interface GenAiLog {
  id: string;
  timestamp: string;
  feature: string;
  model: string;
  latencyMs: number;
  status: 'SUCCESS' | 'FAILED';
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
  errorMessage?: string;
}

// Write usage logs to scratch/genai_usage.json relative to project root
const LOG_FILE = path.join(process.cwd(), 'scratch/genai_usage.json');

export function logGenAiUsage(log: Omit<GenAiLog, 'id' | 'timestamp'>) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    let logs: GenAiLog[] = [];
    if (fs.existsSync(LOG_FILE)) {
      try {
        const data = fs.readFileSync(LOG_FILE, 'utf-8');
        logs = JSON.parse(data);
      } catch {
        logs = [];
      }
    }
    const newLog: GenAiLog = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date().toISOString(),
      ...log,
    };
    logs.unshift(newLog);
    // Limit to 1000 logs
    if (logs.length > 1000) {
      logs = logs.slice(0, 1000);
    }
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to log GenAI usage:', err);
  }
}

export function getGenAiUsageLogs(): GenAiLog[] {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to read GenAI usage logs:', err);
  }
  return [];
}
