// Upload handling and validation.
//
// Memory efficiency: multer DiskStorage streams the request body straight to
// a file, so an upload is never held in RAM. Validation then reads only the
// first `uploadSniffBytes` bytes of that file.
//
// Validation layers
//  1. Extension allow-list (.log, .txt) and a single file field.
//  2. Size limit enforced by multer while streaming (413 if exceeded).
//  3. Content sniffing: empty, binary (NUL bytes) or non-UTF-8 files are rejected,
//     because a renamed binary would otherwise reach the parser/model.
// Stored file names are random UUIDs, so the user's file name is never used as
// a path (no path traversal, no collisions).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import config from '../config/config.js';
import { AppError } from './errorHandler.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!config.allowedExtensions.includes(ext)) {
    return cb(new AppError(415, 'UNSUPPORTED_FILE_TYPE', `Only ${config.allowedExtensions.join(', ')} files are accepted`));
  }
  cb(null, true);
}

export const uploadLogFile = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
}).single('file');

// Reads the head of the stored file and rejects content that is not text.
export async function validateTextContent(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) throw new AppError(400, 'EMPTY_FILE', 'The uploaded file is empty');

    const buf = Buffer.alloc(Math.min(size, config.uploadSniffBytes));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);

    if (head.includes(0)) throw new AppError(415, 'BINARY_FILE', 'The file looks binary, not a text log');
    try {
      // stream:true tolerates a multi-byte character cut at the sample edge.
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: bytesRead < size });
    } catch {
      throw new AppError(415, 'INVALID_ENCODING', 'The file is not valid UTF-8 text');
    }
  } finally {
    await handle.close();
  }
}

// Express middleware: run after uploadLogFile; deletes the file if invalid.
export async function requireValidLog(req, res, next) {
  if (!req.file) return next(new AppError(400, 'NO_FILE', 'Attach a log file in the "file" field'));
  try {
    await validateTextContent(req.file.path);
    next();
  } catch (err) {
    await fs.promises.rm(req.file.path, { force: true });
    next(err);
  }
}
