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
    // Parallel /tokenize calls when counting many log lines (cheap, no inference).
    tokenizeConcurrency: num('AI_TOKENIZE_CONCURRENCY', 4),
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
