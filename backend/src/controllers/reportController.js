import Analysis from '../models/Analysis.js';
import Log from '../models/Log.js';
import { AppError } from '../middleware/errorHandler.js';

async function loadReport(id) {
  const analysis = await Analysis.findById(id).select('logId logName status stage report error').lean();
  if (!analysis) throw new AppError(404, 'ANALYSIS_NOT_FOUND', 'Analysis not found');
  if (!analysis.report) {
    throw new AppError(409, 'REPORT_NOT_READY', analysis.status === 'failed' ? `Analysis failed: ${analysis.error}` : analysis.status === 'cancelled' ? 'The analysis was cancelled before a report was created.' : `Report not ready (${analysis.stage})`);
  }
  const log = await Log.findById(analysis.logId).select('originalName totalLines entryCount issueCount').lean();
  // The uploaded log may have been deleted; the saved report keeps its name.
  return { analysisId: analysis._id, status: analysis.status, log: log || { originalName: analysis.logName }, ...analysis.report };
}

// GET /api/reports/:analysisId
export async function getReport(req, res, next) {
  try {
    res.json(await loadReport(req.params.analysisId));
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/:analysisId/download  (same report as a JSON file)
export async function downloadReport(req, res, next) {
  try {
    const report = await loadReport(req.params.analysisId);
    const base = (report.log?.originalName || 'log').replace(/[^\w.-]/g, '_');
    res.attachment(`security-report-${base}-${report.analysisId}.json`).type('application/json').send(JSON.stringify(report, null, 2));
  } catch (err) {
    next(err);
  }
}
