// model_service: the only module that talks to the local llama.cpp server.
//
// Responsibilities
//  - Exact token counting with the model's own tokenizer (/tokenize).
//  - Exact prompt sizing: messages are rendered with the model's chat template
//    (/apply-template) before counting, so system prompt, template tokens and
//    log content are all included in the count.
//  - Hard context guard: prompt + reserved output + safety margin must fit
//    n_ctx (2048). Oversized requests are rejected BEFORE reaching the model.
//  - One inference at a time (in-process queue) to respect 2 vCPU / 4 GB RAM.
//  - Timeouts (AbortController) and bounded retries for transient failures.
import config from '../config/config.js';
import logger from '../utils/logger.js';

const ai = config.ai;

// Qwen3.5 "thinks" by default; thinking tokens would consume the small output
// budget, so it is disabled for every request (template + completion).
const TEMPLATE_KWARGS = { enable_thinking: false };

export class ModelError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code; // TIMEOUT | UNAVAILABLE | CONTEXT_LIMIT | HTTP_ERROR | BAD_RESPONSE
    this.retryable = retryable;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper with timeout -> ModelError mapping
// ---------------------------------------------------------------------------
async function postJson(endpoint, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ai.baseUrl}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // 503 = model still loading / busy; 5xx are worth a retry, 4xx are not.
      throw new ModelError('HTTP_ERROR', `Model server ${endpoint} returned ${res.status}`, {
        retryable: res.status >= 500,
        details: text.slice(0, 500),
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError('BAD_RESPONSE', `Model server ${endpoint} returned non-JSON`, {
        details: text.slice(0, 500),
      });
    }
  } catch (err) {
    if (err instanceof ModelError) throw err;
    if (err.name === 'AbortError') {
      throw new ModelError('TIMEOUT', `Model request ${endpoint} timed out after ${timeoutMs} ms`, {
        retryable: true,
      });
    }
    // fetch network failure (server not started, connection refused, reset).
    throw new ModelError('UNAVAILABLE', `Model server unreachable at ${ai.baseUrl}: ${err.cause?.code || err.message}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Short timeout for cheap utility endpoints (tokenize, template, health).
const UTILITY_TIMEOUT_MS = Math.min(15000, ai.requestTimeoutMs);

// ---------------------------------------------------------------------------
// Token counting (actual model tokenizer)
// ---------------------------------------------------------------------------
export async function tokenize(text) {
  const data = await postJson('/tokenize', { content: text, add_special: false }, UTILITY_TIMEOUT_MS);
  if (!Array.isArray(data.tokens)) throw new ModelError('BAD_RESPONSE', '/tokenize returned no tokens');
  return data.tokens;
}

export async function detokenize(tokens) {
  const data = await postJson('/detokenize', { tokens }, UTILITY_TIMEOUT_MS);
  if (typeof data.content !== 'string') throw new ModelError('BAD_RESPONSE', '/detokenize returned no content');
  return data.content;
}

export async function countTokens(text) {
  if (!text) return 0;
  return (await tokenize(text)).length;
}

// Renders messages exactly as the model will see them and counts the tokens.
export async function countMessageTokens(messages) {
  const data = await postJson(
    '/apply-template',
    { messages, chat_template_kwargs: TEMPLATE_KWARGS },
    UTILITY_TIMEOUT_MS,
  );
  if (typeof data.prompt !== 'string') throw new ModelError('BAD_RESPONSE', '/apply-template returned no prompt');
  // Rendered prompt contains special tokens as text; parse them as specials.
  const tok = await postJson('/tokenize', { content: data.prompt, add_special: true, parse_special: true }, UTILITY_TIMEOUT_MS);
  return tok.tokens.length;
}

// Token budget helper for chunker/analyzer: how many prompt tokens one request
// may use given a requested output size.
export function promptBudget(maxOutputTokens = ai.reservedOutputTokens) {
  return ai.contextSize - maxOutputTokens - ai.safetyMargin;
}

// ---------------------------------------------------------------------------
// Sequential queue: never run two inferences concurrently.
// ---------------------------------------------------------------------------
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {}); // keep the chain alive after failures
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Chat completion
// ---------------------------------------------------------------------------
/**
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} messages
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]   output tokens (defaults to reserved budget)
 * @param {number} [opts.temperature]
 * @param {object} [opts.jsonSchema]  constrain output to this JSON schema (grammar)
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetries]
 * @returns {Promise<{content:string, promptTokens:number, completionTokens:number, truncated:boolean, durationMs:number, attempts:number}>}
 */
export async function chat(messages, opts = {}) {
  const maxTokens = opts.maxTokens ?? ai.reservedOutputTokens;
  const maxRetries = opts.maxRetries ?? ai.maxRetries;

  // Context guard (exact count, before queueing so callers can re-chunk fast).
  const promptTokens = await countMessageTokens(messages);
  const allowed = promptBudget(maxTokens);
  if (promptTokens > allowed) {
    throw new ModelError(
      'CONTEXT_LIMIT',
      `Prompt uses ${promptTokens} tokens; limit is ${allowed} (ctx ${ai.contextSize} - output ${maxTokens} - margin ${ai.safetyMargin})`,
      { details: { promptTokens, allowed } },
    );
  }

  const body = {
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature ?? ai.temperature,
    chat_template_kwargs: TEMPLATE_KWARGS,
    cache_prompt: false,
  };
  if (opts.jsonSchema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: opts.jsonSchema } };
  }

  return enqueue(async () => {
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        const data = await postJson('/v1/chat/completions', body, opts.timeoutMs ?? ai.requestTimeoutMs);
        const choice = data.choices?.[0];
        if (!choice || typeof choice.message?.content !== 'string') {
          throw new ModelError('BAD_RESPONSE', 'Completion response has no message content', { retryable: true });
        }
        const result = {
          content: choice.message.content,
          promptTokens: data.usage?.prompt_tokens ?? promptTokens,
          completionTokens: data.usage?.completion_tokens ?? 0,
          // finish_reason "length" means output hit max_tokens (JSON may be cut).
          truncated: choice.finish_reason === 'length',
          durationMs: Date.now() - started,
          attempts: attempt,
        };
        logger.debug(`Model call ok: ${result.promptTokens}+${result.completionTokens} tokens in ${result.durationMs} ms`);
        return result;
      } catch (err) {
        const canRetry = err instanceof ModelError && err.retryable && attempt <= maxRetries;
        logger.warn(`Model call failed (attempt ${attempt}/${maxRetries + 1}): ${err.message}`);
        if (!canRetry) throw err;
        await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s, 4s ... backoff
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Health / compatibility check
// ---------------------------------------------------------------------------
// Confirms the server is up and that its real context size can hold our budget.
export async function checkHealth() {
  try {
    await postJson('/health', undefined, UTILITY_TIMEOUT_MS);
    const props = await postJson('/props', undefined, UTILITY_TIMEOUT_MS);
    const serverCtx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
    const ok = !serverCtx || serverCtx >= ai.contextSize;
    return {
      ok,
      serverContext: serverCtx ?? null,
      configuredContext: ai.contextSize,
      maxPromptTokens: promptBudget(),
      reservedOutputTokens: ai.reservedOutputTokens,
      model: props.model_path ?? null,
      error: ok ? null : `Server n_ctx ${serverCtx} is smaller than configured ${ai.contextSize}`,
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

export default { tokenize, detokenize, countTokens, countMessageTokens, promptBudget, chat, checkHealth, ModelError };
