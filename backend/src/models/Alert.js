// A security finding with its evidence (the required finding JSON structure).
//
// stage 'chunk' = raw finding from one chunk (AI or deterministic rule),
// stage 'final' = merged finding of the consolidated report.
//
// Idempotency: `fingerprint` (attack type + identifier + evidence lines) is
// unique per analysis/stage/chunk, so retrying a chunk upserts the same rows
// instead of duplicating findings.
import crypto from 'node:crypto';
import mongoose from 'mongoose';

// Allowed severity values (output contract required by the project brief).
// Attack types are NOT fixed: the model names them from its analysis.
export const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];

const evidenceSchema = new mongoose.Schema(
  {
    line_number: { type: Number, required: true, min: 1 },
    description: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const alertSchema = new mongoose.Schema(
  {
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'Analysis', required: true, index: true },
    logId: { type: mongoose.Schema.Types.ObjectId, ref: 'Log', required: true },
    stage: { type: String, enum: ['chunk', 'final'], required: true },
    chunkIndex: { type: Number, default: null }, // null for final findings
    source: { type: String, enum: ['ai', 'rule', 'correlation'], required: true },
    // Observed = directly shown by log lines; suspected = inferred attack.
    certainty: { type: String, enum: ['observed', 'suspected'], default: 'suspected' },

    attack_type: { type: String, required: true, trim: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    ip_or_identifier: { type: String, required: true, trim: true },
    evidence: {
      type: [evidenceSchema],
      validate: { validator: (v) => v.length > 0, message: 'A finding needs at least one evidence line' },
    },
    reason: { type: String, required: true, trim: true },
    suggested_action: { type: String, required: true, trim: true },

    // Final findings: deterministic facts behind the (suspected) attack label,
    // and who produced the label ('ai' or 'fallback' when the model failed).
    observed_facts: { type: [String], default: undefined },
    label_source: { type: String, enum: ['ai', 'fallback'], default: undefined },

    fingerprint: { type: String, required: true },
  },
  { timestamps: true },
);

alertSchema.index({ analysisId: 1, stage: 1, chunkIndex: 1, fingerprint: 1 }, { unique: true });

export function fingerprintOf(f) {
  const lines = [...new Set(f.evidence.map((e) => e.line_number))].sort((a, b) => a - b).join(',');
  const key = `${f.attack_type.toLowerCase()}|${String(f.ip_or_identifier).toLowerCase()}|${lines}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}

/**
 * Idempotent bulk save. Validates every finding against the schema first;
 * invalid ones are returned (not thrown) so one bad AI finding cannot block
 * the valid ones from the same chunk.
 * @returns {Promise<{saved:number, rejected:Array<{finding:object, error:string}>}>}
 */
alertSchema.statics.upsertMany = async function upsertMany(findings, { analysisId, logId, stage, chunkIndex = null }) {
  const ops = [];
  const rejected = [];
  for (const f of findings) {
    const doc = new this({ ...f, analysisId, logId, stage, chunkIndex, fingerprint: f.evidence?.length ? fingerprintOf(f) : 'invalid' });
    const err = doc.validateSync();
    if (err) {
      rejected.push({ finding: f, error: err.message });
      continue;
    }
    const { _id, ...fields } = doc.toObject();
    ops.push({
      updateOne: {
        filter: { analysisId, stage, chunkIndex, fingerprint: doc.fingerprint },
        update: { $set: fields },
        upsert: true,
      },
    });
  }
  if (ops.length) await this.bulkWrite(ops, { ordered: false });
  return { saved: ops.length, rejected };
};

export default mongoose.model('Alert', alertSchema);
