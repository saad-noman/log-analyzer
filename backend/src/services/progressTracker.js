// progress_tracker: turns a persisted Analysis document into the progress view
// shown by the dashboard. Everything is derived from saved chunk statuses, so
// progress is real (never simulated) and survives restarts.
import { queuePosition } from './analysisRunner.js';

const avg = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);

export function toProgress(analysis) {
  const chunks = analysis.chunks || [];
  const done = chunks.filter((c) => c.status === 'completed');
  const remaining = chunks.filter((c) => c.status === 'pending' || c.status === 'processing').length;
  const avgDuration = avg(done.map((c) => c.durationMs).filter(Number.isFinite));
  const promptTokens = done.map((c) => c.promptTokens).filter(Number.isFinite);

  return {
    id: analysis._id,
    logId: analysis.logId,
    status: analysis.status,
    stage: analysis.stage,
    queuePosition: queuePosition(analysis._id), // 0 = running now, n = waiting behind n jobs
    totalChunks: analysis.totalChunks,
    completedChunks: analysis.completedChunks,
    failedChunks: analysis.failedChunks,
    remainingChunks: remaining,
    percent: analysis.totalChunks ? Math.round(((analysis.completedChunks + analysis.failedChunks) / analysis.totalChunks) * 100) : 0,
    // Estimate from measured chunk durations on this machine.
    etaSeconds: avgDuration !== null && remaining ? Math.round((avgDuration * remaining) / 1000) : null,
    tokens: {
      contextSize: analysis.budget?.contextSize ?? null,
      chunkLogBudget: analysis.budget?.logTokens ?? null,
      avgPromptTokens: promptTokens.length ? Math.round(avg(promptTokens)) : null,
      maxPromptTokens: promptTokens.length ? Math.max(...promptTokens) : null,
      reservedOutput: analysis.budget?.reservedOutput ?? null,
    },
    chunks: chunks.map((c) => ({
      index: c.index,
      startLine: c.startLine,
      endLine: c.endLine,
      tokens: c.tokens,
      status: c.status,
      attempts: c.attempts,
      error: c.error,
      findingsCount: c.findingsCount,
      rejectedCount: c.rejectedCount,
      durationMs: c.durationMs,
    })),
    oversizedEntries: analysis.oversized || [],
    resources: analysis.resources || null, // peak memory measured during this job
    error: analysis.error,
    hasReport: Boolean(analysis.report),
    logName: analysis.logName ?? null,
    // Short report summary for lists (the findings themselves come from /api/reports/:id).
    summary: analysis.report?.summary ? { totalFindings: analysis.report.summary.totalFindings, bySeverity: analysis.report.summary.bySeverity } : null,
    createdAt: analysis.createdAt,
    startedAt: analysis.startedAt,
    finishedAt: analysis.finishedAt,
  };
}

export default { toProgress };
