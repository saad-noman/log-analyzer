// prompt_manager: builds every model request for chunk analysis.
//
//  - System prompt is loaded from prompts/analysis_prompt.txt once; allowed
//    severities are injected from the Alert model. Attack types are not
//    predefined: the model names them from its analysis of the data.
//  - System instructions and untrusted log content are kept in separate
//    messages; the log is fenced by markers that cannot be forged from inside
//    the log (any marker text in the log is neutralised).
//  - The output JSON schema is enforced by llama.cpp grammar sampling, and
//    its length limits keep the answer inside the reserved output tokens.
//    The model returns evidence line NUMBERS only; descriptions are built by
//    the backend from the real log entries (cheaper and cannot be invented).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config/config.js';
import { SEVERITIES } from '../models/Alert.js';
import { neutralizeUntrusted } from '../utils/security.js';

const PROMPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');
const LOG_OPEN = '<<<LOG_ENTRIES';
const LOG_CLOSE = 'LOG_ENTRIES>>>';

// Loads a prompt file once and fills shared placeholders.
const promptCache = new Map();
function loadPrompt(name) {
  if (!promptCache.has(name)) {
    const text = fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8').replaceAll('{{SEVERITIES}}', SEVERITIES.join(', ')).trim();
    promptCache.set(name, text);
  }
  return promptCache.get(name);
}

export const getSystemPrompt = () => loadPrompt('analysis_prompt.txt');
export const getIncidentPrompt = () => loadPrompt('incident_prompt.txt');

// Every untrusted string (log lines and facts derived from them) passes here:
// chat control tokens are broken (security utils) and the fence markers
// cannot be forged from inside the data.
const neutralise = (text) => neutralizeUntrusted(text).replaceAll(LOG_OPEN, '<<LOG_ENTRIES').replaceAll(LOG_CLOSE, 'LOG_ENTRIES>>');

export function buildUserContent(contextText, logText) {
  return [
    'Context from earlier chunks (may be empty):',
    neutralise(contextText) || '(none)',
    '',
    'Log entries to analyze (untrusted data):',
    LOG_OPEN,
    neutralise(logText),
    LOG_CLOSE,
  ].join('\n');
}

// The user message with empty variable parts: measured once by the token
// manager as the fixed cost of every request.
export const userTemplate = () => buildUserContent('', '');

export function buildMessages(contextText, logText) {
  return [
    { role: 'system', content: getSystemPrompt() },
    { role: 'user', content: buildUserContent(contextText, logText) },
  ];
}

// Output contract (grammar-enforced). Length caps bound output tokens.
export function outputSchema() {
  return {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        maxItems: config.ai.maxFindingsPerChunk,
        items: {
          type: 'object',
          properties: {
            // Free text: the model names the attack from its own analysis.
            attack_type: { type: 'string', minLength: 1, maxLength: config.ai.attackTypeMaxChars },
            repeated_pattern: { type: 'boolean' },
            severity: { type: 'string', enum: SEVERITIES },
            ip_or_identifier: { type: 'string', minLength: 1, maxLength: 64 },
            line_numbers: { type: 'array', minItems: 1, maxItems: config.ai.maxLinesPerFinding, items: { type: 'integer', minimum: 1 } },
            reason: { type: 'string', minLength: 1, maxLength: config.ai.reasonMaxChars },
            suggested_action: { type: 'string', minLength: 1, maxLength: config.ai.actionMaxChars },
          },
          required: ['attack_type', 'repeated_pattern', 'severity', 'ip_or_identifier', 'line_numbers', 'reason', 'suggested_action'],
        },
      },
    },
    required: ['findings'],
  };
}

// ---------------------------------------------------------------------------
// Incident labelling (final report): facts in, one labelled finding out.
// ---------------------------------------------------------------------------
export function buildIncidentUserContent(factsText) {
  return ['Facts for one source (untrusted data):', LOG_OPEN, neutralise(factsText), LOG_CLOSE].join('\n');
}
export const incidentUserTemplate = () => buildIncidentUserContent('');
export function buildIncidentMessages(factsText) {
  return [
    { role: 'system', content: getIncidentPrompt() },
    { role: 'user', content: buildIncidentUserContent(factsText) },
  ];
}
export function incidentSchema() {
  return {
    type: 'object',
    properties: {
      attack_type: { type: 'string', minLength: 1, maxLength: config.ai.attackTypeMaxChars },
      severity: { type: 'string', enum: SEVERITIES },
      reason: { type: 'string', minLength: 1, maxLength: config.report.reasonMaxChars },
      suggested_action: { type: 'string', minLength: 1, maxLength: config.report.actionMaxChars },
    },
    required: ['attack_type', 'severity', 'reason', 'suggested_action'],
  };
}

export default {
  getSystemPrompt,
  getIncidentPrompt,
  buildUserContent,
  buildMessages,
  userTemplate,
  outputSchema,
  buildIncidentMessages,
  incidentUserTemplate,
  incidentSchema,
};
