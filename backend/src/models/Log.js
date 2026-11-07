// An uploaded log file. Only metadata and parse statistics are stored; the
// content stays on disk and is re-streamed by the parser when analysed.
import path from 'node:path';
import mongoose from 'mongoose';
import config from '../config/config.js';

const issueSchema = new mongoose.Schema(
  { startLine: Number, endLine: Number, reason: String },
  { _id: false },
);

const logSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    storedName: { type: String, required: true },
    size: { type: Number, required: true },
    totalLines: { type: Number, default: 0 },
    entryCount: { type: Number, default: 0 },
    jsonEntryCount: { type: Number, default: 0 },
    textEntryCount: { type: Number, default: 0 },
    issueCount: { type: Number, default: 0 },
    issues: { type: [issueSchema], default: [] }, // first N parse issues
  },
  { timestamps: true },
);

// Absolute path of the stored file (shared by upload, analysis and delete).
logSchema.methods.filePath = function filePath() {
  return path.join(config.uploadDir, this.storedName);
};

export default mongoose.model('Log', logSchema);
