// log_parser: streams an uploaded log file and turns it into complete entries.
//
// Logs are expected to be a sequence of JSON objects ({...} {...} ...), which
// may be one per line, pretty-printed over several lines, or several on one
// line. A character-level scanner tracks brace depth while respecting JSON
// strings and escapes, so a '{' or '}' inside a value never breaks an object.
// Only COMPLETE objects become entries; an unterminated object at the end of
// the file is reported, never passed on half-finished.
//
// Text outside objects (plain log lines) is kept as one entry per line so
// non-JSON logs still work.
//
// Each entry keeps its original line range plus a few normalized fields
// (ip, user, endpoint, status, timestamp, message) for deterministic
// correlation later. The file is read as a stream; nothing is copied whole.
import fs from 'node:fs';
import config from '../config/config.js';

// Key aliases used by common JSON log formats (lower-cased, without _ - .).
// Order = priority: an earlier alias wins over a later one, whatever the key
// order inside the log object (e.g. "client_ip" beats a server "host").
const FIELD_ALIASES = {
  ip: ['clientip', 'srcip', 'sourceip', 'remoteaddr', 'remoteip', 'ip', 'ipaddress', 'xforwardedfor', 'client', 'src', 'host'],
  user: ['user', 'username', 'usr', 'account', 'login', 'userid', 'useremail', 'email', 'principal'],
  endpoint: ['endpoint', 'path', 'url', 'uri', 'request', 'route', 'requesturi', 'resource'],
  method: ['method', 'httpmethod', 'verb'],
  status: ['status', 'statuscode', 'httpstatus', 'responsecode', 'code', 'result', 'outcome'],
  timestamp: ['timestamp', 'time', 'ts', 'datetime', 'date', '@timestamp', 'eventtime'],
  event: ['event', 'eventtype', 'action', 'type', 'category'],
  message: ['message', 'msg', 'log', 'description', 'details'],
};
// normalized key -> { field, rank } (rank = position in the alias list)
const ALIAS_LOOKUP = new Map(
  Object.entries(FIELD_ALIASES).flatMap(([field, keys]) => keys.map((k, rank) => [k, { field, rank }])),
);
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;
const looksLikeIp = (v) => IPV4.test(v) || (v.includes(':') && IPV6.test(v));

const normalizeKey = (k) => k.toLowerCase().replace(/[_\-.\s]/g, '');

// Walks nested objects (depth-limited) and maps known keys to fields.
// For each field the highest-priority alias wins (never simply the first key
// seen); the ip field only takes IP-looking values.
function extractFields(obj, out = {}, depth = 0, ranks = {}) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      extractFields(value, out, depth + 1, ranks);
      continue;
    }
    const alias = ALIAS_LOOKUP.get(normalizeKey(key));
    if (!alias || value === null || value === '') continue;
    const text = String(value);
    // The ip field identifies a network source, so only IP-looking values are
    // accepted (a "host" holding the server name is not an attacker IP).
    if (alias.field === 'ip' && !looksLikeIp(text)) continue;
    const score = alias.rank; // lower = higher-priority alias
    if (ranks[alias.field] === undefined || score < ranks[alias.field]) {
      out[alias.field] = text;
      ranks[alias.field] = score;
    }
  }
  return out;
}

function fieldsFromText(text) {
  const ip = text.match(IPV4)?.[0];
  return ip ? { ip, message: text } : { message: text };
}

// ---------------------------------------------------------------------------
// Schema inference: which key holds the source IP, path, status, time and
// method is learned from the VALUES of the whole file, so logs with unknown
// key names (e.g. "src_addr", "uri", "resp_code") are still understood.
// Key names (FIELD_ALIASES) only break ties between candidates.
// ---------------------------------------------------------------------------
const pcfg = config.parser;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']); // HTTP protocol vocabulary
const VALUE_ROLES = {
  ip: (v) => typeof v === 'string' && looksLikeIp(v),
  endpoint: (v) => typeof v === 'string' && /^(\/|https?:\/\/)\S*$/i.test(v),
  status: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 100 && n < 600;
  },
  timestamp: (v) => (typeof v === 'string' && /\d{2}/.test(v) && v.length >= 8 && !Number.isNaN(Date.parse(v))) || (typeof v === 'number' && v > 1e9),
  method: (v) => typeof v === 'string' && HTTP_METHODS.has(v.toUpperCase()),
};

function flatten(obj, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) flatten(v, `${prefix}${k}.`, out, depth + 1);
    else if (v !== null && v !== '' && typeof v !== 'object') out[prefix + k] = v;
  }
  return out;
}

const aliasBonus = (role, path) => {
  const rank = (FIELD_ALIASES[role] || []).indexOf(normalizeKey(path.split('.').pop()));
  return rank === -1 ? 0 : 1 - rank / FIELD_ALIASES[role].length;
};

/** @returns {Record<string,string>} role -> key path chosen for this file */
export function inferSchema(entries) {
  const stats = new Map(); // path -> { count, hits: {role: n}, distinct: Set }
  let jsonEntries = 0;
  for (const e of entries) {
    if (e.kind !== 'json') continue;
    let flat;
    try {
      flat = flatten(JSON.parse(e.text));
    } catch {
      continue;
    }
    jsonEntries++;
    for (const [path, v] of Object.entries(flat)) {
      let s = stats.get(path);
      if (!s) stats.set(path, (s = { count: 0, hits: {}, distinct: new Set() }));
      s.count++;
      if (s.distinct.size <= pcfg.schemaMaxDistinctTracked) s.distinct.add(String(v));
      for (const [role, test] of Object.entries(VALUE_ROLES)) if (test(v)) s.hits[role] = (s.hits[role] || 0) + 1;
    }
  }

  const schema = {};
  for (const role of Object.keys(VALUE_ROLES)) {
    let best = null;
    for (const [path, s] of stats) {
      const typed = (s.hits[role] || 0) / s.count; // how consistently values have this shape
      if (typed < pcfg.schemaMinTypedRatio) continue;
      const cardinality = s.distinct.size / s.count;
      // Status codes repeat a few values; numbers like durations do not.
      if (role === 'status' && cardinality > pcfg.schemaMaxStatusCardinality && !aliasBonus(role, path)) continue;
      const coverage = s.count / Math.max(1, jsonEntries);
      // Source IPs vary across entries more than a fixed server address.
      const score = typed + coverage + aliasBonus(role, path) + (role === 'ip' ? cardinality : 0);
      if (!best || score > best.score) best = { path, score };
    }
    if (best) schema[role] = best.path;
  }
  return schema;
}

/** Overrides alias-based fields with the file's inferred schema. */
function applySchema(entries, schema) {
  if (!Object.keys(schema).length) return;
  for (const e of entries) {
    if (e.kind !== 'json') continue;
    let flat;
    try {
      flat = flatten(JSON.parse(e.text));
    } catch {
      continue;
    }
    for (const [role, path] of Object.entries(schema)) {
      const v = flat[path];
      if (v !== undefined && VALUE_ROLES[role](v)) e.fields[role] = String(v);
    }
  }
}

// Short, factual description of an entry built from its parsed fields
// (used for evidence text, so descriptions always reflect the real log line).
export function describeEntry(entry, maxLength = 120) {
  const f = entry.fields || {};
  const parts = [
    f.event,
    f.method && f.endpoint ? `${f.method} ${f.endpoint}` : f.endpoint,
    f.status && `status ${f.status}`,
    f.user && `user ${f.user}`,
    f.ip && `from ${f.ip}`,
  ].filter(Boolean);
  const out = parts.length ? parts.join(', ') : f.message || entry.text;
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

/**
 * Reusable streaming scanner for top-level JSON objects in text.
 * Tracks brace depth, JSON strings/escapes and line numbers. Used by the log
 * parser (files) and by the analyzer (salvaging complete objects from a
 * truncated model response).
 * @param {{onObject:(raw:string,startLine:number,endLine:number)=>void,
 *          onText?:(text:string,line:number)=>void}} handlers
 *   onText receives non-object text, one call per line (untrimmed).
 */
export function createObjectScanner({ onObject, onText = () => {} }) {
  let line = 1;
  let depth = 0; // brace depth of the object being read (0 = outside)
  let inString = false;
  let escaped = false;
  let objBuf = '';
  let objStart = 0;
  let textBuf = ''; // text outside objects on the current line

  const flushText = () => {
    if (textBuf) onText(textBuf, line);
    textBuf = '';
  };

  return {
    feed(piece) {
      for (const ch of piece) {
        if (depth === 0) {
          if (ch === '{') {
            flushText(); // text before an object on the same line is its own entry
            depth = 1;
            objStart = line;
            objBuf = '{';
            inString = false;
            escaped = false;
          } else if (ch === '\n') {
            flushText();
            line++;
          } else if (ch !== '\r') {
            textBuf += ch;
          }
          continue;
        }

        // Inside an object: track strings so braces in values are ignored.
        objBuf += ch;
        if (ch === '\n') line++;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          onObject(objBuf, objStart, line);
          objBuf = '';
        }
      }
    },
    // Call once at the end. Returns the unterminated object, if any.
    end() {
      if (depth > 0) return { startLine: objStart, raw: objBuf };
      flushText();
      return null;
    },
    get line() {
      return line;
    },
  };
}

/**
 * Parses a log file into complete entries.
 * @returns {Promise<{entries: Array<{index:number,startLine:number,endLine:number,
 *   kind:'json'|'text', text:string, fields:object}>,
 *   issues: Array<{startLine:number,endLine:number,reason:string}>, totalLines:number}>}
 *   `text` is the compact form sent to the model (minified JSON or trimmed line).
 */
export async function parseLogFile(filePath) {
  const entries = [];
  const issues = []; // invalid / unterminated objects, reported to the user
  const pushEntry = (entry) => entries.push({ index: entries.length, ...entry });

  const scanner = createObjectScanner({
    onText(raw, line) {
      const text = raw.trim();
      if (text) pushEntry({ startLine: line, endLine: line, kind: 'text', text, fields: fieldsFromText(text) });
    },
    onObject(raw, startLine, endLine) {
      try {
        const data = JSON.parse(raw);
        // Minified JSON costs fewer tokens than the original formatting.
        pushEntry({ startLine, endLine, kind: 'json', text: JSON.stringify(data), fields: extractFields(data) });
      } catch (err) {
        // Balanced braces but invalid JSON: keep the evidence as text, flag it.
        issues.push({ startLine, endLine, reason: `Invalid JSON object: ${err.message}` });
        const text = raw.replace(/\s+/g, ' ').trim();
        pushEntry({ startLine, endLine, kind: 'text', text, fields: fieldsFromText(text) });
      }
    },
  });

  let lastChar = '';
  for await (const piece of fs.createReadStream(filePath, { encoding: 'utf8' })) {
    if (piece.length) lastChar = piece[piece.length - 1];
    scanner.feed(piece);
  }
  const unterminated = scanner.end();
  const line = scanner.line;

  // `line` is one past the last line when the file ends with a newline.
  const totalLines = lastChar === '' ? 0 : Math.max(line - (lastChar === '\n' ? 1 : 0), 1);

  if (unterminated) {
    // File ended inside an object: it is incomplete, so it is NOT an entry.
    issues.push({ startLine: unterminated.startLine, endLine: totalLines, reason: 'Unterminated JSON object at end of file (dropped)' });
  }

  // Learn this file's field layout from its values, then normalise all entries.
  const schema = inferSchema(entries);
  applySchema(entries, schema);

  return { entries, issues, totalLines, schema };
}

export default { parseLogFile, createObjectScanner, describeEntry, inferSchema };
