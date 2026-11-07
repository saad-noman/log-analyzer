// One analysis job: planned chunks, their statuses and the shared context
// carried between chunks. Everything is persisted as it happens so a crash or
// failed model call never loses completed work, and a job can be resumed.
import mongoose from 'mongoose';
import Alert from './Alert.js';

export const JOB_STATUSES = ['queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'];
export const CHUNK_STATUSES = ['pending', 'processing', 'completed', 'failed'];

const chunkSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true },
    // Contiguous range of parser entry indices (lets a resume rebuild the
    // exact same chunk without re-planning).
    entryStart: { type: Number, required: true },
    entryEnd: { type: Number, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    tokens: { type: Number, required: true }, // log-content tokens
    text: { type: String, required: true }, // exact chunk text sent to the model (resume-safe)
    status: { type: String, enum: CHUNK_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
    findingsCount: { type: Number, default: 0 },
    rejectedCount: { type: Number, default: 0 }, // AI findings failing validation
    promptTokens: { type: Number, default: null },
    completionTokens: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const analysisSchema = new mongoose.Schema(
  {
    logId: { type: mongoose.Schema.Types.ObjectId, ref: 'Log', required: true, index: true },
    logName: { type: String, default: null }, // kept so a saved report keeps its name after the log is deleted
    status: { type: String, enum: JOB_STATUSES, default: 'queued' },
    stage: { type: String, default: 'queued' }, // human-readable current step
    budget: { type: Object, default: null }, // token budget used for planning
    totalChunks: { type: Number, default: 0 },
    completedChunks: { type: Number, default: 0 },
    failedChunks: { type: Number, default: 0 },
    chunks: { type: [chunkSchema], default: [] },
    oversized: { type: [Object], default: [] }, // entries too large to analyse whole
    // Compact cross-chunk state (suspicious IPs, accounts, counters, line refs).
    sharedContext: { type: Object, default: {} },
    report: { type: Object, default: null },
    // Peak memory of node + model + database measured while this job ran.
    resources: { type: Object, default: null },
    error: { type: String, default: null },
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true, minimize: false },
);

// Creates the job with all chunks planned up front (progress totals known).
analysisSchema.statics.createJob = function createJob(logId, { budget, chunks, oversized }, logName = null) {
  return this.create({
    logId,
    logName,
    budget,
    oversized,
    totalChunks: chunks.length,
    chunks: chunks.map((c) => ({
      index: c.index,
      entryStart: c.entryIndices[0],
      entryEnd: c.entryIndices[c.entryIndices.length - 1],
      startLine: c.startLine,
      endLine: c.endLine,
      tokens: c.tokens,
      text: c.text,
    })),
  });
};

analysisSchema.statics.markChunkProcessing = async function markChunkProcessing(id, index) {
  await this.updateOne(
    { _id: id, 'chunks.index': index },
    { $set: { 'chunks.$.status': 'processing', stage: `Analyzing chunk ${index + 1}` }, $inc: { 'chunks.$.attempts': 1 } },
  );
  await this.refreshCounters(id); // a retried failed chunk is no longer counted as failed
};

/**
 * Saves a successful chunk immediately:
 *  1. findings are upserted (idempotent, so a crash + retry cannot duplicate),
 *  2. then ONE atomic update marks the chunk completed, stores its stats and
 *     the new shared context; progress counters are then recomputed.
 * The status filter (`$ne: 'completed'`) makes step 2 safe to repeat.
 */
analysisSchema.statics.saveChunkResult = async function saveChunkResult(analysis, index, { findings, sharedContext, stats }) {
  const { saved, rejected } = await Alert.upsertMany(findings, {
    analysisId: analysis._id,
    logId: analysis.logId,
    stage: 'chunk',
    chunkIndex: index,
  });
  await this.updateOne(
    { _id: analysis._id, chunks: { $elemMatch: { index, status: { $ne: 'completed' } } } },
    {
      $set: {
        'chunks.$.status': 'completed',
        'chunks.$.error': null,
        'chunks.$.findingsCount': saved,
        'chunks.$.rejectedCount': rejected.length,
        'chunks.$.promptTokens': stats.promptTokens ?? null,
        'chunks.$.completionTokens': stats.completionTokens ?? null,
        'chunks.$.durationMs': stats.durationMs ?? null,
        'chunks.$.completedAt': new Date(),
        sharedContext,
      },
    },
  );
  await this.refreshCounters(analysis._id);
  return { saved, rejected };
};

// A chunk that failed after all retries is recorded, never silently skipped.
analysisSchema.statics.markChunkFailed = async function markChunkFailed(id, index, error) {
  await this.updateOne(
    { _id: id, 'chunks.index': index },
    { $set: { 'chunks.$.status': 'failed', 'chunks.$.error': String(error).slice(0, 1000) } },
  );
  await this.refreshCounters(id);
};

// Progress counters are derived from chunk statuses (never drift, even when a
// failed chunk is retried successfully). Uses an update pipeline, so it is atomic.
const countStatus = (status) => ({ $size: { $filter: { input: '$chunks', cond: { $eq: ['$$this.status', status] } } } });
analysisSchema.statics.refreshCounters = function refreshCounters(id) {
  return this.updateOne({ _id: id }, [{ $set: { completedChunks: countStatus('completed'), failedChunks: countStatus('failed') } }]);
};

// Chunks still to do (pending, or interrupted while processing) - for resume.
analysisSchema.methods.remainingChunks = function remainingChunks() {
  return this.chunks.filter((c) => c.status === 'pending' || c.status === 'processing');
};

export default mongoose.model('Analysis', analysisSchema);
