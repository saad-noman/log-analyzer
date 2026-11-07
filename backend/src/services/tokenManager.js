// token_manager: plans and enforces the 2,048-token budget of every model call.
//
// All counts come from the model's own tokenizer through modelService
// (no character-based estimates). Budget of ONE request:
//
//   n_ctx (2048) = fixed prompt   (system prompt + instructions + chat template tokens)
//                + shared context (compact cross-chunk state, trimmed to fit)
//                + log content    (the chunk)
//                + reserved output (max_tokens for the JSON answer)
//                + safety margin
//
// The chunker asks planBudget() how many tokens are left for log lines, and
// verifyRequest() does an exact final count of the assembled messages.
// modelService.chat() repeats that exact check as a last line of defence.
import config from '../config/config.js';
import model, { ModelError } from './modelService.js';

const ai = config.ai;

// Cache of fixed-prompt costs: the same system prompt/template is measured once
// per analysis instead of once per chunk.
const fixedCostCache = new Map();

/**
 * Exact cost of the parts of a request that do not depend on the log chunk:
 * system prompt, user-message wrapper text and chat-template tokens.
 * @param {string} systemPrompt
 * @param {string} userTemplate  user message with the variable parts removed
 */
export async function measureFixedCost(systemPrompt, userTemplate = '') {
  const key = `${systemPrompt}\u0000${userTemplate}`;
  if (!fixedCostCache.has(key)) {
    const tokens = await model.countMessageTokens([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userTemplate },
    ]);
    fixedCostCache.set(key, tokens);
  }
  return fixedCostCache.get(key);
}

/**
 * Splits one request's budget into its parts.
 * @returns {{contextSize:number, reservedOutput:number, safetyMargin:number,
 *            fixedTokens:number, contextTokens:number, logTokens:number}}
 *          logTokens = tokens the chunker may fill with log lines.
 */
export async function planBudget({ systemPrompt, userTemplate = '', contextTokens = 0, maxOutputTokens = ai.reservedOutputTokens }) {
  const fixedTokens = await measureFixedCost(systemPrompt, userTemplate);
  const promptLimit = model.promptBudget(maxOutputTokens);
  const logTokens = promptLimit - fixedTokens - contextTokens;
  if (logTokens <= 0) {
    throw new ModelError(
      'CONTEXT_LIMIT',
      `No room for log content: fixed ${fixedTokens} + context ${contextTokens} >= prompt limit ${promptLimit}`,
    );
  }
  return {
    contextSize: ai.contextSize,
    reservedOutput: maxOutputTokens,
    safetyMargin: ai.safetyMargin,
    fixedTokens,
    contextTokens,
    logTokens,
  };
}

/**
 * Counts tokens for many texts (e.g. log lines) with bounded parallelism.
 * Tokenizing is cheap compared with inference, but the cap keeps the
 * llama-server HTTP threads and memory calm. Returns counts in input order.
 */
export async function countTokensBatch(texts, concurrency = ai.tokenizeConcurrency) {
  const counts = new Array(texts.length);
  let next = 0;
  async function worker() {
    while (next < texts.length) {
      const i = next++;
      counts[i] = await model.countTokens(texts[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return counts;
}

/**
 * Cuts text to at most maxTokens tokens (token-exact) and appends a marker.
 * Used for a single log entry that alone exceeds the chunk budget, so that it
 * is analysed in shortened form instead of being dropped or overflowing.
 */
export async function truncateToTokens(text, maxTokens, marker = ' …[truncated]') {
  const tokens = await model.tokenize(text);
  if (tokens.length <= maxTokens) return { text, tokens: tokens.length, truncated: false };
  const markerTokens = await model.countTokens(marker);
  const keep = Math.max(0, maxTokens - markerTokens);
  const cut = (await model.detokenize(tokens.slice(0, keep))) + marker;
  return { text: cut, tokens: keep + markerTokens, truncated: true };
}

/**
 * Selects shared-context items that fit within maxTokens.
 * Items must be ordered by priority (most important first, e.g. high-severity
 * suspects before low ones). Each item is a short text line; items that do
 * not fit are skipped and reported so callers know what was left out.
 * @param {string[]} items
 * @param {number} maxTokens
 * @returns {Promise<{text:string, tokens:number, included:number, dropped:number}>}
 */
export async function fitContext(items, maxTokens, separator = '\n') {
  if (!items.length || maxTokens <= 0) return { text: '', tokens: 0, included: 0, dropped: items.length };
  const sepTokens = await model.countTokens(separator);
  const counts = await countTokensBatch(items);
  const kept = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const cost = counts[i] + (kept.length ? sepTokens : 0);
    if (used + cost > maxTokens) continue; // a shorter, lower-priority item may still fit
    kept.push(items[i]);
    used += cost;
  }
  const text = kept.join(separator);
  // Exact recount of the joined text (BPE can merge across boundaries).
  const tokens = await model.countTokens(text);
  return { text, tokens, included: kept.length, dropped: items.length - kept.length };
}

/**
 * Exact final check of fully assembled messages against the budget.
 * @returns {Promise<{promptTokens:number, allowed:number, fits:boolean, overBy:number}>}
 */
export async function verifyRequest(messages, maxOutputTokens = ai.reservedOutputTokens) {
  const promptTokens = await model.countMessageTokens(messages);
  const allowed = model.promptBudget(maxOutputTokens);
  return { promptTokens, allowed, fits: promptTokens <= allowed, overBy: Math.max(0, promptTokens - allowed) };
}

export default { measureFixedCost, planBudget, countTokensBatch, truncateToTokens, fitContext, verifyRequest };
