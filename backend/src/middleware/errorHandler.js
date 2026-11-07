// Central error handling: every error leaves the API as { error: { code, message } }
// with a user-level message. Technical details are written to the server log only.
import multer from 'multer';
import logger from '../utils/logger.js';
import { toUserMessage } from '../utils/userMessages.js';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details; // app-controlled data only (e.g. analysisId)
  }
}

const MODEL_ERROR_STATUS = { UNAVAILABLE: 503, TIMEOUT: 503, CONTEXT_LIMIT: 422, HTTP_ERROR: 502, BAD_RESPONSE: 502 };

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Not found'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';

  if (err.name === 'ModelError') {
    // Local model problems: unreachable/slow => 503 (retry later), bad output => 502.
    status = MODEL_ERROR_STATUS[err.code] ?? 502;
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
  } else if (err.name === 'CastError') {
    status = 400;
    code = 'INVALID_ID';
  } else if (!(err instanceof AppError) && status < 500 && !err.code) {
    code = 'BAD_REQUEST';
  }
  // Internal errors never expose library/driver codes (e.g. MongoDB numeric codes).
  if (status >= 500 && err.name !== 'ModelError' && !(err instanceof AppError)) code = 'INTERNAL_ERROR';

  // Full technical detail stays server-side.
  if (status >= 500 || err.name === 'ModelError') logger.error(`${req.method} ${req.originalUrl} -> ${status} ${code}: ${err.stack || err.message}`);

  const details = err instanceof AppError && err.details && !Array.isArray(err.details) ? err.details : undefined;
  res.status(status).json({ error: { code, message: toUserMessage({ ...err, name: err.name, code, message: err.message }, status), ...(details ? { details } : {}) } });
}
