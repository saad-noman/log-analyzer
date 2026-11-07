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

// Key aliases used by common JSON log formats (lower-cased, without _ - .).
const FIELD_ALIASES = {
  ip: ['ip', 'clientip', 'srcip', 'sourceip', 'remoteaddr', 'remoteip', 'client', 'src', 'host', 'ipaddress', 'xforwardedfor'],
  user: ['user', 'username', 'usr', 'account', 'login', 'userid', 'useremail', 'email', 'principal'],
  endpoint: ['endpoint', 'path', 'url', 'uri', 'request', 'route', 'requesturi', 'resource'],
  method: ['method', 'httpmethod', 'verb'],
  status: ['status', 'statuscode', 'httpstatus', 'responsecode', 'code', 'result', 'outcome'],
  timestamp: ['timestamp', 'time', 'ts', 'datetime', 'date', '@timestamp', 'eventtime'],
  event: ['event', 'eventtype', 'action', 'type', 'category'],
  message: ['message', 'msg', 'log', 'description', 'details'],
};
const ALIAS_LOOKUP = new Map(
  Object.entries(FIELD_ALIASES).flatMap(([field, keys]) => keys.map((k) => [k, field])),
);
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;

const normalizeKey = (k) => k.toLowerCase().replace(/[_\-.\s]/g, '');

// Walks nested objects (depth-limited) and maps known keys to fields.
function extractFields(obj, out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      extractFields(value, out, depth + 1);
      continue;
    }
    const field = ALIAS_LOOKUP.get(normalizeKey(key));
    if (field && out[field] === undefined && value !== null && value !== '') out[field] = String(value);
  }
  return out;
}

function fieldsFromText(text) {
  const ip = text.match(IPV4)?.[0];
  return ip ? { ip, message: text } : { message: text };
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

  let line = 1;
  let depth = 0; // brace depth of the object being read (0 = outside)
  let inString = false;
  let escaped = false;
  let objBuf = '';
  let objStart = 0;
  let textBuf = ''; // plain text outside objects on the current line

  const pushEntry = (entry) => entries.push({ index: entries.length, ...entry });

  const flushText = () => {
    const text = textBuf.trim();
    textBuf = '';
    if (text) pushEntry({ startLine: line, endLine: line, kind: 'text', text, fields: fieldsFromText(text) });
  };

  const finishObject = () => {
    try {
      const data = JSON.parse(objBuf);
      // Minified JSON costs fewer tokens than the original formatting.
      pushEntry({ startLine: objStart, endLine: line, kind: 'json', text: JSON.stringify(data), fields: extractFields(data) });
    } catch (err) {
      // Balanced braces but invalid JSON: keep the evidence as text, flag it.
      issues.push({ startLine: objStart, endLine: line, reason: `Invalid JSON object: ${err.message}` });
      const text = objBuf.replace(/\s+/g, ' ').trim();
      pushEntry({ startLine: objStart, endLine: line, kind: 'text', text, fields: fieldsFromText(text) });
    }
    objBuf = '';
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let lastChar = '';
  for await (const piece of stream) {
    if (piece.length) lastChar = piece[piece.length - 1];
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
      else if (ch === '}' && --depth === 0) finishObject();
    }
  }

  // `line` is one past the last line when the file ends with a newline.
  const totalLines = lastChar === '' ? 0 : Math.max(line - (lastChar === '\n' ? 1 : 0), 1);

  if (depth > 0) {
    // File ended inside an object: it is incomplete, so it is NOT an entry.
    issues.push({ startLine: objStart, endLine: totalLines, reason: 'Unterminated JSON object at end of file (dropped)' });
  } else {
    flushText();
  }

  return { entries, issues, totalLines };
}

export default { parseLogFile };
