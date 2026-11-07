// chunker: groups parsed log entries into chunks that fit the log-token budget
// of one model request (budget comes from tokenManager.planBudget()).
//
// Rule: a chunk always ends on a COMPLETE entry (a whole JSON object).
//   {...} {...} {...}   -> accepted
//   {...} {...} {...    -> never produced; the last object moves to the next chunk
//
// How:
//  1. Each entry is formatted as "L<start>[-<end>]: <compact JSON>" so the model
//     can cite original line numbers, and counted with the real tokenizer.
//  2. Whole entries are added greedily while their summed cost fits.
//  3. The joined chunk text is recounted exactly (BPE may merge tokens across
//     entry boundaries). While it is over budget, the LAST entry is dropped
//     whole and carried into the next chunk. Entries are never cut.
//
// One entry larger than the whole budget cannot be sent complete:
//  - JSON object: skipped for AI analysis and reported in `oversized`
//    (cutting it would give the model a broken object). Its parsed fields are
//    still available to deterministic correlation.
//  - Plain text line: shortened token-exactly with a visible marker.
import model from './modelService.js';
import tm from './tokenManager.js';

const SEPARATOR = '\n';

export function formatEntry(entry) {
  const range = entry.endLine > entry.startLine ? `${entry.startLine}-${entry.endLine}` : `${entry.startLine}`;
  return `L${range}: ${entry.text}`;
}

/**
 * @param {Array} entries      output of logParser.parseLogFile().entries
 * @param {number} logTokens   tokens available for log content per request
 * @returns {Promise<{chunks: Array<{index:number, entryIndices:number[], text:string,
 *   tokens:number, startLine:number, endLine:number}>, oversized: Array<{startLine:number,
 *   endLine:number, tokens:number, reason:string}>}>}
 */
export async function buildChunks(entries, logTokens) {
  if (!Number.isInteger(logTokens) || logTokens <= 0) throw new Error(`Invalid log token budget: ${logTokens}`);

  const lines = entries.map(formatEntry);
  const costs = await tm.countTokensBatch(lines);
  const sepTokens = await model.countTokens(SEPARATOR);

  const chunks = [];
  const oversized = [];
  let i = 0;

  while (i < entries.length) {
    // An entry that alone exceeds the budget.
    if (costs[i] > logTokens) {
      const e = entries[i];
      if (e.kind === 'json') {
        oversized.push({ startLine: e.startLine, endLine: e.endLine, tokens: costs[i], reason: `JSON entry needs ${costs[i]} tokens; chunk budget is ${logTokens}` });
      } else {
        const cut = await tm.truncateToTokens(lines[i], logTokens);
        chunks.push(makeChunk(chunks.length, [i], [cut.text], cut.tokens, entries));
      }
      i++;
      continue;
    }

    // Greedy fill with whole entries (estimated from per-entry counts).
    const taken = [];
    let used = 0;
    for (let j = i; j < entries.length; j++) {
      const cost = costs[j] + (taken.length ? sepTokens : 0);
      if (costs[j] > logTokens || used + cost > logTokens) break;
      taken.push(j);
      used += cost;
    }

    // Exact recount; drop the last WHOLE entry until the chunk fits.
    let text = taken.map((k) => lines[k]).join(SEPARATOR);
    let tokens = await model.countTokens(text);
    while (tokens > logTokens && taken.length > 1) {
      taken.pop();
      text = taken.map((k) => lines[k]).join(SEPARATOR);
      tokens = await model.countTokens(text);
    }

    chunks.push(makeChunk(chunks.length, taken, null, tokens, entries, text));
    i = taken[taken.length - 1] + 1;
  }

  return { chunks, oversized };
}

function makeChunk(index, entryIndices, parts, tokens, entries, text = parts.join(SEPARATOR)) {
  return {
    index,
    entryIndices,
    text,
    tokens,
    startLine: entries[entryIndices[0]].startLine,
    endLine: entries[entryIndices[entryIndices.length - 1]].endLine,
  };
}

export default { buildChunks, formatEntry };
