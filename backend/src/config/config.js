// Central configuration. Every tunable value comes from the root .env file
// so nothing about the model, token budget or paths is hardcoded in code.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const backendRoot = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(projectRoot, '.env') });

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  return value;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 5000),
  // Local, offline tool: listen on loopback only unless explicitly changed.
  host: str('HOST', '127.0.0.1'),
  clientOrigin: str('CLIENT_ORIGIN', 'http://localhost:5173'),
  mongodbUri: str('MONGODB_URI', 'mongodb://127.0.0.1:27017/log_analyzer'),

  ai: {
    baseUrl: str('AI_BASE_URL', 'http://127.0.0.1:8080'),
    modelPath: path.resolve(projectRoot, str('AI_MODEL_PATH', '')),
    contextSize: num('AI_CONTEXT_SIZE', 2048),
    // Output tokens reserved for every response (also used as max_tokens).
    reservedOutputTokens: num('AI_RESERVED_OUTPUT_TOKENS', num('AI_MAX_TOKENS', 384)),
    // Extra headroom for tokenizer/template differences.
    safetyMargin: num('AI_TOKEN_SAFETY_MARGIN', 128),
    temperature: num('AI_TEMPERATURE', 0.1),
    requestTimeoutMs: num('AI_REQUEST_TIMEOUT_MS', 180000),
    maxRetries: num('AI_MAX_RETRIES', 2),
    maxFindingsPerChunk: num('AI_MAX_FINDINGS_PER_CHUNK', 10),
    // Grammar-enforced text caps per finding: long reasons would exhaust the
    // output budget and cut off later findings.
    attackTypeMaxChars: num('AI_ATTACK_TYPE_MAX_CHARS', 60),
    reasonMaxChars: num('AI_REASON_MAX_CHARS', 120),
    actionMaxChars: num('AI_ACTION_MAX_CHARS', 80),
    maxLinesPerFinding: num('AI_MAX_LINES_PER_FINDING', 12),
    // When the model says a finding is a repeated pattern, it must cite at
    // least this many entries; otherwise the claim is rejected as unsupported.
    minEvidenceForPattern: num('AI_MIN_EVIDENCE_FOR_PATTERN', 3),
    // Tokens reserved in every request for the compact cross-chunk context
    // (suspicious IPs, accounts, prior findings). Fixed so all chunks can be
    // planned up front and progress (total chunks) is known before analysis.
    contextReserveTokens: num('AI_CONTEXT_RESERVE_TOKENS', 200),
    // Parallel /tokenize calls when counting many log lines (cheap, no inference).
    tokenizeConcurrency: num('AI_TOKENIZE_CONCURRENCY', 4),
    // Startup: how long the API waits for the model (started by npm run dev) before resuming jobs.
    startupWaitMs: num('AI_STARTUP_WAIT_MS', 120000),
    startupPollMs: num('AI_STARTUP_POLL_MS', 1000),
  },

  // Schema inference: field roles are learned from the values of each file.
  parser: {
    schemaMinTypedRatio: num('SCHEMA_MIN_TYPED_RATIO', 0.9), // share of a key's values that must have the role's shape
    schemaMaxStatusCardinality: num('SCHEMA_MAX_STATUS_CARDINALITY', 0.2), // status codes repeat; durations etc. do not
    schemaMaxDistinctTracked: num('SCHEMA_MAX_DISTINCT_TRACKED', 5000),
  },

  // Deterministic correlation (behaviour facts, never attack names).
  correlation: {
    // Vocabulary for recognising authentication events in any log format.
    authContextPattern: new RegExp(str('AUTH_CONTEXT_PATTERN', 'login|logon|log-in|signin|sign-in|auth|password|passwd|credential|session|token|sshd'), 'i'),
    authFailurePattern: new RegExp(str('AUTH_FAILURE_PATTERN', 'fail|denied|invalid|incorrect|unauthori[sz]ed|forbidden|rejected|bad password|wrong'), 'i'),
    authSuccessPattern: new RegExp(str('AUTH_SUCCESS_PATTERN', 'success|succeeded|accepted|logged in|authenticated|granted'), 'i'),
    authFailureStatuses: str('AUTH_FAILURE_STATUSES', '401,403').split(',').map(Number),
    // Repeated events needed before a behaviour counts as a pattern.
    minRepeats: num('CORRELATION_MIN_REPEATS', num('AI_MIN_EVIDENCE_FOR_PATTERN', 3)),
    // Behaviour is judged against the other IPs/accounts of the SAME file:
    // a value is anomalous when its robust z-score (median + MAD) reaches this.
    outlierZ: num('CORRELATION_OUTLIER_Z', 3.5),
    // Minimum spread, as a share of the median, used in that z-score.
    outlierMinRelativeScale: num('CORRELATION_OUTLIER_MIN_RELATIVE_SCALE', 0.25),
    // Below this many actors there is no reliable baseline; only absolute
    // patterns (failure streaks, access after denial, payloads) are reported,
    // plus breadth with a high error ratio.
    minPopulation: num('CORRELATION_MIN_POPULATION', 5),
    breadthMinErrorRatio: num('CORRELATION_BREADTH_MIN_ERROR_RATIO', 0.5),
    // Characters rarely present in normal request parameters (quotes, comment
    // markers, brackets, encoded quotes/brackets). Many of them in one
    // endpoint is reported as a payload anomaly; the AI names the attack.
    payloadCharPattern: new RegExp(str('PAYLOAD_CHAR_PATTERN', "['\"`;<>(){}|\\\\]|--|/\\*|%27|%22|%3c|%3e|%3b"), 'gi'),
    payloadMinMatches: num('CORRELATION_PAYLOAD_MIN_MATCHES', 2),
    maxPayloadSamples: num('CORRELATION_MAX_PAYLOAD_SAMPLES', 2),
    payloadSampleChars: num('CORRELATION_PAYLOAD_SAMPLE_CHARS', 80),
    maxLinesPerSignal: num('CORRELATION_MAX_LINES_PER_SIGNAL', 50),
    maxTrackedEndpoints: num('CORRELATION_MAX_TRACKED_ENDPOINTS', 500),
    maxLinked: num('CORRELATION_MAX_LINKED', 20),
  },

  // Final report generation.
  report: {
    maxEvidence: num('REPORT_MAX_EVIDENCE', 20), // evidence lines kept per final finding
    labelMaxTokens: num('REPORT_LABEL_MAX_TOKENS', 160), // output tokens of one labelling call
    maxAiLabels: num('REPORT_MAX_AI_LABELS', 20), // incidents labelled by the model (rest: fallback)
    typeSimilarity: num('REPORT_TYPE_SIMILARITY', 0.5), // word overlap to treat two AI labels as one attack
    mergeOverlap: num('REPORT_MERGE_OVERLAP', 0.5), // shared evidence ratio to merge two incidents
    reasonMaxChars: num('REPORT_REASON_MAX_CHARS', 200),
    actionMaxChars: num('REPORT_ACTION_MAX_CHARS', 120),
  },

  // Prompt-injection and output guardrails (patterns are configurable).
  security: {
    // Chat-template control tokens (<|im_start|>, <|im_end|>, <|endoftext|>, ...).
    controlTokenPattern: new RegExp(str('CONTROL_TOKEN_PATTERN', '<\\|[^|<>\\s]{1,40}\\|>'), 'g'),
    // Reasoning tags of the model's template.
    reasoningTagPattern: new RegExp(str('REASONING_TAG_PATTERN', '</?think>'), 'gi'),
    // Text that addresses an AI/automation instead of describing an event.
    injectionPattern: new RegExp(
      str(
        'INJECTION_PATTERN',
        'ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)|disregard (all |the )?(previous|above|prior)|forget (all |your )?(previous |prior )?instructions|you are now|new instructions|system prompt|\\b(system|assistant)\\s*:|return \\{\\s*"findings"|<\\|im_(start|end)\\|>',
      ),
      'i',
    ),
  },

  // Resource monitoring against the 4 GB limit.
  resources: {
    memoryLimitMb: num('MEMORY_LIMIT_MB', 4096),
    warnRatio: num('MEMORY_WARN_RATIO', 0.9),
    modelProcessName: str('MODEL_PROCESS_NAME', 'llama-server'),
    // Optional runtime cap for MongoDB's WiredTiger cache (unset = leave as is).
    mongoCacheMb: num('MONGO_WIREDTIGER_CACHE_MB', 0),
  },

  uploadDir: path.resolve(backendRoot, str('UPLOAD_DIR', '../uploads')),
  reportDir: path.resolve(backendRoot, str('REPORT_DIR', '../reports')),
  maxUploadBytes: num('MAX_UPLOAD_MB', 25) * 1024 * 1024,
  allowedExtensions: str('ALLOWED_EXTENSIONS', '.log,.txt').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // Bytes inspected to reject binary / non-UTF-8 files without reading them whole.
  uploadSniffBytes: num('UPLOAD_SNIFF_BYTES', 64 * 1024),
  // Parse issues stored per upload (the total count is always stored).
  maxStoredIssues: num('MAX_STORED_ISSUES', 100),
};

// Token budget: the whole request (prompt + context + log chunk) may use at
// most this many tokens, so that prompt + reserved output + margin <= n_ctx.
config.ai.maxPromptTokens =
  config.ai.contextSize - config.ai.reservedOutputTokens - config.ai.safetyMargin;

if (config.ai.maxPromptTokens <= 0) {
  throw new Error('Invalid token budget: reserved output + safety margin exceed the context size');
}

export default config;
