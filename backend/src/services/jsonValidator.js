// json_validator: turns raw model text into validated findings, never throwing
// on bad model output.
//
// Tolerates the ways a small model breaks JSON:
//  - markdown code fences or prose around the JSON,
//  - a bare array, or a single finding object instead of {"findings":[...]},
//  - output cut at max_tokens (complete objects are salvaged with the same
//    scanner the log parser uses; the half-written last one is discarded),
//  - severity in the wrong case, line numbers as strings ("L42", "3-6") or as
//    evidence objects.
// Every finding is validated on its own, so one bad finding never discards the
// valid ones from the same response.
import config from '../config/config.js';
import { SEVERITIES } from '../models/Alert.js';
import { createObjectScanner, describeEntry } from './logParser.js';
import { sanitizeModelText, detectInjection } from '../utils/security.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

// Normalises any accepted top-level shape to an array of candidate items.
function itemsOf(data, key) {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return null;
  if (Array.isArray(data[key])) return data[key];
  if (Object.keys(data).length === 0) return [];
  if ('attack_type' in data) return [data]; // a single finding without wrapper
  return null;
}

/**
 * Parses model output. Never throws.
 * @returns {{items: object[]|null, salvaged: boolean, error: string|null}}
 *   items === null means nothing usable could be recovered.
 */
export function parseJsonResponse(content, key = 'findings') {
  const raw = text(content).replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = raw.search(/[[{]/);
  if (start === -1) return { items: null, salvaged: false, error: 'No JSON found in model output' };
  const body = raw.slice(start);

  try {
    const items = itemsOf(JSON.parse(body), key);
    return items ? { items, salvaged: false, error: null } : { items: null, salvaged: false, error: 'Unexpected JSON shape' };
  } catch (err) {
    // Incomplete/malformed: recover complete objects inside the target array.
    const keyAt = body.indexOf(`"${key}"`);
    const arrayAt = body.indexOf('[', keyAt === -1 ? 0 : keyAt);
    if (arrayAt === -1) return { items: null, salvaged: false, error: `Malformed JSON: ${err.message}` };
    const items = [];
    const scanner = createObjectScanner({
      onObject(obj) {
        try {
          items.push(JSON.parse(obj));
        } catch {
          /* broken object: skipped */
        }
      },
    });
    scanner.feed(body.slice(arrayAt + 1));
    return { items, salvaged: true, error: items.length ? null : `Malformed JSON: ${err.message}` };
  }
}

export function normalizeSeverity(value) {
  const v = text(value).toLowerCase();
  return SEVERITIES.find((s) => s.toLowerCase() === v) ?? null;
}

// Accepts [12, "L13", "14-16"] or [{line_number: 12}] and returns integers.
export function toLineNumbers(raw) {
  const list = Array.isArray(raw.line_numbers) ? raw.line_numbers : Array.isArray(raw.evidence) ? raw.evidence.map((e) => (isObject(e) ? e.line_number : e)) : [];
  return list.map((v) => parseInt(String(v).replace(/^\D+/, ''), 10)).filter((n) => Number.isInteger(n) && n > 0);
}

// Maps every original line covered by an entry (multi-line JSON too) to it.
export function indexLines(entries) {
  const byLine = new Map();
  for (const e of entries) for (let l = e.startLine; l <= e.endLine; l++) byLine.set(l, e);
  return byLine;
}

/**
 * Validates one AI finding and grounds it in the real chunk entries.
 * @returns {{finding?: object, error?: string}}
 */
/**
 * Output guardrail shared by chunk findings and report labels: sanitizes the
 * model's text fields and rejects answers that carry instruction-like text
 * (a sign that log content steered the model).
 * @returns {{label?: {attack_type, severity, reason, suggested_action}, error?: string}}
 */
export function cleanLabel(raw, limits = { attackType: config.ai.attackTypeMaxChars, reason: config.ai.reasonMaxChars, action: config.ai.actionMaxChars }) {
  if (!isObject(raw)) return { error: 'Answer is not an object' };
  const label = {
    attack_type: sanitizeModelText(raw.attack_type, limits.attackType),
    severity: normalizeSeverity(raw.severity),
    reason: sanitizeModelText(raw.reason, limits.reason),
    suggested_action: sanitizeModelText(raw.suggested_action, limits.action),
  };
  if (!label.attack_type) return { error: 'Missing attack_type' };
  if (!label.severity) return { error: `Invalid severity "${raw.severity}"` };
  const injected = ['attack_type', 'reason', 'suggested_action'].find((k) => detectInjection(label[k]));
  if (injected) return { error: `Model ${injected} contains instruction-like text (possible prompt injection)` };
  return { label };
}

export function groundFinding(raw, byLine) {
  const { label, error } = cleanLabel(raw);
  if (error) return { error };
  const { attack_type: attackType, severity } = label;
  const id = sanitizeModelText(raw.ip_or_identifier, config.ai.attackTypeMaxChars);
  if (!id) return { error: 'Missing ip_or_identifier' };

  // Cited lines must exist in this chunk; one evidence item per entry.
  const lines = toLineNumbers(raw);
  const cited = new Map();
  for (const n of lines) {
    const entry = byLine.get(n);
    if (entry) cited.set(entry.startLine, entry);
  }
  if (!cited.size) return { error: `No cited line exists in this chunk (${JSON.stringify(lines)})` };

  // Evidence must concern the reported source: drop cited lines that do not
  // mention the identifier (the model sometimes cites neighbouring lines).
  const needle = id.toLowerCase();
  for (const [line, e] of cited) if (!e.text.toLowerCase().includes(needle)) cited.delete(line);
  if (!cited.size) return { error: `Identifier "${id}" does not appear in the cited lines` };

  // The model's own claim of a repeated pattern must be backed by repetition.
  if (raw.repeated_pattern === true && cited.size < config.ai.minEvidenceForPattern) {
    return { error: `"${attackType}" claimed as a repeated pattern but cites only ${cited.size} entries (min ${config.ai.minEvidenceForPattern})` };
  }

  return {
    finding: {
      attack_type: attackType,
      severity,
      ip_or_identifier: id,
      evidence: [...cited.values()]
        .sort((a, b) => a.startLine - b.startLine)
        .map((e) => ({ line_number: e.startLine, description: describeEntry(e) })),
      reason: label.reason || 'Suspicious activity reported by the model',
      suggested_action: label.suggested_action || 'Review the cited log lines',
      source: 'ai',
      certainty: 'suspected', // model output is an inference, never a confirmed fact
    },
  };
}

/** Validates many raw findings; never throws. */
export function groundFindings(items, entries) {
  const byLine = indexLines(entries);
  const findings = [];
  const rejected = [];
  for (const raw of items) {
    const { finding, error } = groundFinding(raw, byLine);
    if (finding) findings.push(finding);
    else rejected.push({ finding: raw, error });
  }
  return { findings, rejected };
}

/**
 * Strict check of the required final finding structure (used before a
 * finding enters the report). Returns a list of problems (empty = valid).
 */
export function validateFinding(f) {
  const errors = [];
  if (!isObject(f)) return ['Finding is not an object'];
  for (const k of ['attack_type', 'ip_or_identifier', 'reason', 'suggested_action']) if (!text(f[k])) errors.push(`Missing ${k}`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`Invalid severity "${f.severity}"`);
  if (!Array.isArray(f.evidence) || !f.evidence.length) errors.push('Evidence must be a non-empty array');
  else
    f.evidence.forEach((e, i) => {
      if (!Number.isInteger(e?.line_number) || e.line_number < 1) errors.push(`evidence[${i}].line_number must be a positive integer`);
      if (!text(e?.description)) errors.push(`evidence[${i}].description is required`);
    });
  return errors;
}

export default { parseJsonResponse, cleanLabel, normalizeSeverity, toLineNumbers, indexLines, groundFinding, groundFindings, validateFinding };
