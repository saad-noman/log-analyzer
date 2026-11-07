import fs from 'node:fs';
import path from 'node:path';
import config from '../config/config.js';
import Log from '../models/Log.js';
import { parseLogFile } from '../services/logParser.js';
import { AppError } from '../middleware/errorHandler.js';

// POST /api/logs/upload  (after uploadLogFile + requireValidLog)
// Parses the stored file once (streaming) to confirm it contains log entries
// and to record line/entry statistics shown before analysis starts.
export async function uploadLog(req, res, next) {
  const { file } = req;
  try {
    const parsed = await parseLogFile(file.path);
    if (parsed.entries.length === 0) {
      throw new AppError(422, 'NO_LOG_ENTRIES', 'No complete log entries were found in the file', parsed.issues.slice(0, 10));
    }

    const jsonEntryCount = parsed.entries.filter((e) => e.kind === 'json').length;
    const log = await Log.create({
      originalName: path.basename(file.originalname),
      storedName: file.filename,
      size: file.size,
      totalLines: parsed.totalLines,
      entryCount: parsed.entries.length,
      jsonEntryCount,
      textEntryCount: parsed.entries.length - jsonEntryCount,
      issueCount: parsed.issues.length,
      issues: parsed.issues.slice(0, config.maxStoredIssues),
    });
    res.status(201).json(log);
  } catch (err) {
    await fs.promises.rm(file.path, { force: true }); // never keep rejected files
    next(err);
  }
}

export async function listLogs(req, res, next) {
  try {
    res.json(await Log.find().sort({ createdAt: -1 }).select('-issues'));
  } catch (err) {
    next(err);
  }
}

export async function getLog(req, res, next) {
  try {
    const log = await Log.findById(req.params.id);
    if (!log) throw new AppError(404, 'LOG_NOT_FOUND', 'Log not found');
    res.json(log);
  } catch (err) {
    next(err);
  }
}

export async function deleteLog(req, res, next) {
  try {
    const log = await Log.findByIdAndDelete(req.params.id);
    if (!log) throw new AppError(404, 'LOG_NOT_FOUND', 'Log not found');
    await fs.promises.rm(log.filePath(), { force: true });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
