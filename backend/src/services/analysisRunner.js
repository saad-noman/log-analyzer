// analysisRunner: orchestrates one analysis job end to end.
//
//   parse file -> plan chunks (token budget) -> for each chunk, sequentially:
//     apply deterministic correlation -> AI analysis with compact context ->
//     save findings + state immediately (or record the failure)
//   -> consolidated report.
//
// Jobs run one at a time (the CPU model is the bottleneck and RAM is
// limited). A job can be resumed: completed chunks are skipped, failed or
// interrupted chunks are retried, and stored chunk text is reused exactly.
import Log from '../models/Log.js';
import Analysis from '../models/Analysis.js';
import { parseLogFile } from './logParser.js';
import { planChunks } from './chunker.js';
import prompts from './promptManager.js';
import { analyzeChunk } from './analyzer.js';
import correlation from './correlation.js';
import { generateReport } from './reportGenerator.js';
import { checkHealth } from './modelService.js';
import logger from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import resourceMonitor from './resourceMonitor.js';
import { toUserMessage } from '../utils/userMessages.js';

// ---------------------------------------------------------------------------
// analysis_queue: one job (and one model request) at a time. `pending` mirrors
// the queue so the API can report queue positions and refuse duplicates.
//
// Fair scheduling: while other jobs are waiting, a running job processes one
// chunk, then yields and re-joins the back of the queue (round-robin). A small
// file therefore finishes after a few chunk turns instead of waiting for a
// large job to complete. Progress is saved after every chunk, so a yielded job
// resumes exactly where it stopped.
// ---------------------------------------------------------------------------
let tail = Promise.resolve();
const pending = []; // analysis ids waiting or running, in order
const YIELD = Symbol('yield');

function enqueue(analysisId, options) {
  const id = String(analysisId);
  if (pending.includes(id)) return false; // already queued/running
  pending.push(id);
  const run = async () => {
    let outcome;
    try {
      outcome = await runJob(id, options);
    } finally {
      pending.splice(pending.indexOf(id), 1);
    }
    if (outcome === YIELD) enqueue(id, options); // back of the queue
  };
  tail = tail.then(run, run);
  return true;
}
const othersWaiting = (id) => pending.some((p) => p !== String(id));
const isCancelled = async (id) => Boolean(await Analysis.exists({ _id: id, status: 'cancelled' }));

/** 0 = running now, n = jobs ahead, null = not in the queue. */
export function queuePosition(analysisId) {
  const i = pending.indexOf(String(analysisId));
  return i === -1 ? null : i;
}
export const isQueued = (analysisId) => queuePosition(analysisId) !== null;

const setStage = (id, stage, extra = {}) => Analysis.updateOne({ _id: id }, { $set: { stage, ...extra } });
const ACTIVE = ['queued', 'running'];

/** Plans the job (chunk count known immediately) and queues its execution. */
export async function startAnalysis(logId) {
  const log = await Log.findById(logId);
  if (!log) throw new AppError(404, 'LOG_NOT_FOUND', 'Log not found');
  const active = await Analysis.findOne({ logId, status: { $in: ACTIVE } }).select('_id');
  if (active) throw new AppError(409, 'ANALYSIS_IN_PROGRESS', 'This log is already being analysed', { analysisId: active._id });

  const { entries } = await parseLogFile(log.filePath());
  const plan = await planChunks(entries, { systemPrompt: prompts.getSystemPrompt(), userTemplate: prompts.userTemplate() });
  if (!plan.chunks.length) throw new AppError(422, 'NOTHING_TO_ANALYZE', 'No log entry fits the model context', { oversized: plan.oversized.length });
  const analysis = await Analysis.createJob(log._id, plan, log.originalName);
  enqueue(analysis._id);
  return analysis;
}

/**
 * Safe retry: re-runs only chunks that are not completed (failed ones too).
 * Completed chunks and their findings are untouched; findings are upserted
 * by fingerprint and correlation is idempotent, so nothing is duplicated.
 */
export async function retryAnalysis(analysisId) {
  const analysis = await Analysis.findById(analysisId).select('status failedChunks completedChunks totalChunks');
  if (!analysis) throw new AppError(404, 'ANALYSIS_NOT_FOUND', 'Analysis not found');
  if (isQueued(analysisId)) throw new AppError(409, 'ANALYSIS_IN_PROGRESS', 'Analysis is already queued or running');
  if (analysis.status === 'completed') throw new AppError(409, 'NOTHING_TO_RETRY', 'All chunks completed successfully');
  await setStage(analysisId, 'Queued for retry', { status: 'queued', error: null });
  enqueue(analysisId, { retryFailed: true });
  return analysis;
}

/**
 * Cancels a queued or running job. A running job stops after its current
 * chunk; completed chunks and findings stay saved, so it can be retried later.
 */
export async function cancelAnalysis(analysisId) {
  const res = await Analysis.updateOne(
    { _id: analysisId, status: { $in: ACTIVE } },
    { $set: { status: 'cancelled', stage: 'Cancelled', finishedAt: new Date() } },
  );
  if (!res.matchedCount) {
    if (!(await Analysis.exists({ _id: analysisId }))) throw new AppError(404, 'ANALYSIS_NOT_FOUND', 'Analysis not found');
    throw new AppError(409, 'NOT_RUNNING', 'This analysis is not queued or running.');
  }
}

/** On server start: re-queue jobs interrupted by a shutdown or crash. */
export async function resumeInterrupted() {
  const jobs = await Analysis.find({ status: { $in: ACTIVE } }).sort({ createdAt: 1 }).select('_id');
  for (const job of jobs) enqueue(job._id, { retryFailed: false });
  return jobs.length;
}

async function runJob(analysisId, { retryFailed = false } = {}) {
  let analysis = await Analysis.findById(analysisId);
  if (!analysis || analysis.status === 'cancelled') return undefined; // cancelled while waiting
  try {
    const log = await Log.findById(analysis.logId);
    if (!log) throw new AppError(410, 'LOG_GONE', 'The uploaded log file no longer exists. Upload it again.');

    const health = await checkHealth();
    if (!health.ok) {
      logger.warn(`Model health check failed: ${health.error}`);
      throw new AppError(503, 'MODEL_OFFLINE', 'The local AI model is not running. Start it, then retry the analysis.');
    }

    await setStage(analysisId, 'Parsing log file', { status: 'running', startedAt: analysis.startedAt ?? new Date(), error: null });
    const { entries } = await parseLogFile(log.filePath()); // streamed; entries are compact
    const state = analysis.sharedContext?.actors ? analysis.sharedContext : correlation.createState();

    const todo = analysis.chunks.filter((c) => c.status !== 'completed' && (retryFailed || c.status !== 'failed'));
    let peak = analysis.resources;
    const sampleMemory = async (label) => {
      const s = await resourceMonitor.check(label);
      if (!peak || s.totalMb > peak.totalMb) peak = { ...s, measuredAt: new Date(), during: label };
    };
    for (const chunk of todo) {
      const chunkEntries = entries.slice(chunk.entryStart, chunk.entryEnd + 1);
      await Analysis.markChunkProcessing(analysisId, chunk.index);

      // Deterministic facts first (idempotent), so the model sees them as context
      // and they survive even if this chunk's model call fails.
      correlation.applyChunk(state, chunk.index, chunkEntries);
      try {
        const result = await analyzeChunk({ chunkText: chunk.text, entries: chunkEntries, contextItems: correlation.contextItems(state), budget: analysis.budget });
        await Analysis.saveChunkResult(analysis, chunk.index, { findings: result.findings, sharedContext: state, stats: result.stats });
        logger.info(`Chunk ${chunk.index + 1}/${analysis.totalChunks}: ${result.findings.length} findings, ${result.rejected.length} rejected`);
      } catch (err) {
        logger.warn(`Chunk ${chunk.index + 1}/${analysis.totalChunks} failed: ${err.message}`);
        // Saved text is user-level; the technical reason is in the log line above.
        await Analysis.markChunkFailed(analysisId, chunk.index, toUserMessage(err));
        await Analysis.updateOne({ _id: analysisId }, { $set: { sharedContext: state } });
        // Model server down (after modelService retries): stop instead of
        // failing every remaining chunk; completed work stays saved for a retry.
        if (err.code === 'UNAVAILABLE') throw new AppError(503, 'MODEL_OFFLINE', `The local AI model stopped responding at chunk ${chunk.index + 1}. Completed work is saved; start the model and retry.`);
      }
      // Sampled right after inference, when the model's buffers are in use.
      await sampleMemory(`chunk ${chunk.index + 1}`);
      await Analysis.updateOne({ _id: analysisId }, { $set: { resources: peak } });

      if (await isCancelled(analysisId)) {
        logger.info(`Analysis ${analysisId} cancelled after chunk ${chunk.index + 1}`);
        return undefined;
      }
      // Fair scheduling: give the model to the next waiting job, resume later.
      const left = todo.indexOf(chunk) < todo.length - 1;
      if (left && othersWaiting(analysisId)) {
        await setStage(analysisId, 'Waiting for its turn (another analysis is sharing the model)', { status: 'queued' });
        return YIELD;
      }
    }

    await setStage(analysisId, 'Generating report');
    analysis = await Analysis.findById(analysisId);
    const modelAvailable = (await checkHealth()).ok;
    const report = await generateReport({ analysis, state, entries, modelAvailable });
    await sampleMemory('report generation');
    report.summary.resources = peak;
    const status = analysis.failedChunks > 0 ? 'completed_with_errors' : 'completed';
    await setStage(analysisId, status === 'completed' ? 'Completed' : `Completed with ${analysis.failedChunks} failed chunk(s)`, { status, report, resources: peak, finishedAt: new Date() });
  } catch (err) {
    if (await isCancelled(analysisId)) return undefined; // a cancel wins over a late failure
    logger.error(`Analysis ${analysisId} failed: ${err.message}`);
    await setStage(analysisId, 'Failed', { status: 'failed', error: toUserMessage(err), finishedAt: new Date() });
  }
}

export default { startAnalysis, retryAnalysis, cancelAnalysis, resumeInterrupted, queuePosition, isQueued };
