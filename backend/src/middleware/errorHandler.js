// Central error handling: every error leaves the API as { error: { code, message } }.
import multer from 'multer';
import logger from '../utils/logger.js';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Unexpected error';

  if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code;
  } else if (err.name === 'CastError') {
    status = 400;
    code = 'INVALID_ID';
    message = 'Invalid id';
  }

  if (status >= 500) logger.error(`${req.method} ${req.originalUrl}: ${err.stack || message}`);
  res.status(status).json({ error: { code, message, ...(err.details ? { details: err.details } : {}) } });
}
