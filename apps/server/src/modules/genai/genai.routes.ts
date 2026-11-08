import { Router, Request, Response } from 'express';
import { getGenAiUsageLogs } from '../../lib/genaiLogger.js';

export const genaiRouter: Router = Router();

genaiRouter.get('/usage', (req: Request, res: Response) => {
  const logs = getGenAiUsageLogs();

  const totalRequests = logs.length;
  const successRequests = logs.filter((l) => l.status === 'SUCCESS').length;
  const failedRequests = logs.filter((l) => l.status === 'FAILED').length;
  const rateLimitHits = logs.filter(
    (l) => l.status === 'FAILED' && l.errorMessage?.includes('rate limit')
  ).length;

  const successRate = totalRequests > 0 ? (successRequests / totalRequests) * 100 : 100;

  const totalTokens = logs.reduce((sum, l) => sum + (l.totalTokens || 0), 0);
  const totalPromptTokens = logs.reduce((sum, l) => sum + (l.promptTokens || 0), 0);
  const totalResponseTokens = logs.reduce((sum, l) => sum + (l.responseTokens || 0), 0);

  const successfulLogs = logs.filter((l) => l.status === 'SUCCESS');
  const avgLatencyMs =
    successfulLogs.length > 0
      ? successfulLogs.reduce((sum, l) => sum + l.latencyMs, 0) / successfulLogs.length
      : 0;

  // Group by feature
  const byFeature: Record<
    string,
    { count: number; success: number; failed: number; totalTokens: number; avgLatencyMs: number }
  > = {};

  logs.forEach((log) => {
    if (!byFeature[log.feature]) {
      byFeature[log.feature] = { count: 0, success: 0, failed: 0, totalTokens: 0, avgLatencyMs: 0 };
    }
    const feat = byFeature[log.feature];
    if (feat) {
      feat.count++;
      if (log.status === 'SUCCESS') {
        feat.success++;
        feat.avgLatencyMs += log.latencyMs;
      } else {
        feat.failed++;
      }
      feat.totalTokens += log.totalTokens || 0;
    }
  });

  // Calculate averages per feature
  Object.keys(byFeature).forEach((key) => {
    const feat = byFeature[key];
    if (feat && feat.success > 0) {
      feat.avgLatencyMs = feat.avgLatencyMs / feat.success;
    }
  });

  // Group by model
  const byModel: Record<string, number> = {};
  logs.forEach((log) => {
    byModel[log.model] = (byModel[log.model] || 0) + 1;
  });

  res.json({
    summary: {
      totalRequests,
      successRequests,
      failedRequests,
      successRate,
      rateLimitHits,
      totalTokens,
      totalPromptTokens,
      totalResponseTokens,
      avgLatencyMs,
    },
    byFeature,
    byModel,
    logs,
  });
});

