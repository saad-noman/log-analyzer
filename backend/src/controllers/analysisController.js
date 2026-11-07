import mongoose from 'mongoose';
import Analysis from '../models/Analysis.js';
import Alert from '../models/Alert.js';
import { startAnalysis, retryAnalysis, cancelAnalysis, isQueued } from '../services/analysisRunner.js';
import { toProgress } from '../services/progressTracker.js';
import { AppError } from '../middleware/errorHandler.js';

// Heavy fields never sent in progress responses.
// report.summary stays (small) so hasReport and finding counts are correct.
const LIGHT = '-chunks.text -sharedContext -report.findings -resources.system';
// Lists drop the whole chunks array (excluding chunks AND chunks.text together is a MongoDB path collision).
const LIST = '-chunks -sharedContext -report.findings -resources.system';

async function findOr404(id, select = LIGHT) {
  const analysis = await Analysis.findById(id).select(select).lean();
  if (!analysis) throw new AppError(404, 'ANALYSIS_NOT_FOUND', 'Analysis not found');
  return analysis;
}

// POST /api/analyses  { logId }
export async function createAnalysis(req, res, next) {
  try {
    const { logId } = req.body || {};
    if (typeof logId !== 'string' || !mongoose.isValidObjectId(logId)) throw new AppError(400, 'INVALID_LOG_ID', 'Body must contain a valid "logId"');
    const analysis = await startAnalysis(logId);
    res.status(202).location(`/api/analyses/${analysis._id}`).json(toProgress(analysis.toObject()));
  } catch (err) {
    next(err);
  }
}

// GET /api/analyses?logId=
export async function listAnalyses(req, res, next) {
  try {
    const filter = mongoose.isValidObjectId(req.query.logId) ? { logId: req.query.logId } : {};
    const list = await Analysis.find(filter).sort({ createdAt: -1 }).select(LIST).lean();
    res.json(list.map((a) => ({ ...toProgress(a), chunks: undefined })));
  } catch (err) {
    next(err);
  }
}

// GET /api/analyses/:id  (progress, polled by the dashboard)
export async function getAnalysis(req, res, next) {
  try {
    res.json(toProgress(await findOr404(req.params.id)));
  } catch (err) {
    next(err);
  }
}

// POST /api/analyses/:id/retry  (safe retry of failed/unfinished chunks)
export async function retry(req, res, next) {
  try {
    await retryAnalysis(req.params.id);
    res.status(202).json(toProgress(await findOr404(req.params.id)));
  } catch (err) {
    next(err);
  }
}

// POST /api/analyses/:id/cancel  (stops after the current chunk; work is kept)
export async function cancel(req, res, next) {
  try {
    await cancelAnalysis(req.params.id);
    res.json(toProgress(await findOr404(req.params.id)));
  } catch (err) {
    next(err);
  }
}

// GET /api/analyses/:id/findings?stage=chunk  (raw per-chunk findings, for inspection)
export async function listChunkFindings(req, res, next) {
  try {
    await findOr404(req.params.id, '_id');
    const stage = req.query.stage === 'final' ? 'final' : 'chunk';
    const findings = await Alert.find({ analysisId: req.params.id, stage }).sort({ chunkIndex: 1, createdAt: 1 }).select('-fingerprint -__v').lean();
    res.json(findings);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/analyses/:id
export async function deleteAnalysis(req, res, next) {
  try {
    // A cancelled job may still hold a queue slot; its turn is skipped, so deleting is safe.
    const current = await Analysis.findById(req.params.id).select('status').lean();
    if (isQueued(req.params.id) && current?.status !== 'cancelled') throw new AppError(409, 'ANALYSIS_IN_PROGRESS', 'Cancel the analysis before deleting it.');
    const deleted = await Analysis.findByIdAndDelete(req.params.id);
    if (!deleted) throw new AppError(404, 'ANALYSIS_NOT_FOUND', 'Analysis not found');
    await Alert.deleteMany({ analysisId: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
