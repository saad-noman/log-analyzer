// analyzer: runs ONE chunk through the local model and returns validated,
// evidence-grounded findings in the final finding structure.
//
// Steps
//  1. Fit the shared context into its reserved tokens (tokenManager).
//  2. Build messages (promptManager) and verify the exact request size; if
//     tokenizer boundary effects push it over, shrink the context, never the log.
//  3. Call the model with a grammar-enforced JSON schema (modelService).
//  4. Parse the JSON; if the answer was cut at max_tokens, salvage every
//     complete finding object with the same scanner the log parser uses.
//  5. Validate and ground each finding against the real chunk entries:
//     - cited line numbers must belong to entries in THIS chunk,
//     - only cited entries that mention ip_or_identifier are kept as evidence,
//     - a finding the model marks as a repeated pattern must cite enough entries,
//     - attack_type is the model's own label (no predefined list),
//     - evidence descriptions are written from the actual log data.
//     Unsupported findings are rejected (and counted), not saved.
import model, { ModelError } from './modelService.js';
import tm from './tokenManager.js';
import prompts from './promptManager.js';
import validator from './jsonValidator.js';

/**
 * @param {object} p
 * @param {string} p.chunkText     formatted chunk (chunker output)
 * @param {Array}  p.entries       parser entries contained in the chunk
 * @param {string[]} [p.contextItems]  compact context lines, highest priority first
 * @param {object} p.budget        budget from chunker.planChunks()
 */
export async function analyzeChunk({ chunkText, entries, contextItems = [], budget }) {
  // 1-2. Context within its reserve, then exact verification of the request.
  let ctx = await tm.fitContext(contextItems, budget.contextTokens);
  let messages = prompts.buildMessages(ctx.text, chunkText);
  let check = await tm.verifyRequest(messages, budget.reservedOutput);
  if (!check.fits) {
    ctx = await tm.fitContext(contextItems, ctx.tokens - check.overBy);
    messages = prompts.buildMessages(ctx.text, chunkText);
    check = await tm.verifyRequest(messages, budget.reservedOutput);
    if (!check.fits) throw new ModelError('CONTEXT_LIMIT', `Chunk request is ${check.overBy} tokens over the limit`);
  }

  // 3. Inference (sequential queue, timeout and retries live in modelService).
  const res = await model.chat(messages, { maxTokens: budget.reservedOutput, jsonSchema: prompts.outputSchema() });

  // 4. Parse / salvage.
  const parsed = validator.parseJsonResponse(res.content);
  if (parsed.items === null) {
    // Nothing recoverable: the caller records the chunk as failed/retries it.
    throw new ModelError('BAD_RESPONSE', `${parsed.error}${res.truncated ? ' (truncated)' : ''}`, {
      retryable: true,
      details: res.content.slice(0, 300),
    });
  }

  // 5. Validate and ground every finding independently.
  const { findings, rejected } = validator.groundFindings(parsed.items, entries);

  return {
    findings,
    rejected,
    truncated: res.truncated,
    salvaged: parsed.salvaged,
    stats: {
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      durationMs: res.durationMs,
      attempts: res.attempts,
      contextIncluded: ctx.included,
      contextDropped: ctx.dropped,
    },
  };
}

export default { analyzeChunk };
