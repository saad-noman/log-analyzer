# AI Usage

This document records how AI was used to build this project. It covers the coding assistant, the prompts sent to the local model, how those prompts changed, the token-budget strategy, and concrete AI mistakes that were found and fixed.

## 1. AI tools used

| Tool | Role |
|---|---|
| **Claude Code** (Anthropic), in VS Code | Coding assistant: inspected the repository, proposed the plan, wrote and refactored backend and frontend code, ran tests against the live local model, and drafted documentation. Every change was reviewed and directed step by step by the developer. |
| **Qwen3.5-2B (Q4_K_M GGUF) via llama.cpp** | The runtime AI inside the application. It analyses log chunks and names attacks. It runs fully offline on CPU; no cloud AI API is used at runtime. |

## 2. Key coding prompts (developer → coding assistant)

The work was done in small, verifiable steps. Each prompt asked the assistant to inspect the repository first, reuse existing modules, avoid hardcoding and keep the code explainable.

1. *Understand the brief and the repository state; the stack is MERN with Qwen3.5 2B through llama.cpp (not Ollama).*
2. *Inspect the project, list completed / incomplete / missing parts, create a checklist and recommend the next step.*
3. *Set up the local model and verify CPU inference.*
4. *Implement `model_service`: connect the local model, test inference, timeouts and real responses.*
5. *Implement `token_manager` with the model's actual tokenizer and the full 2,048-token budget.*
6. *Logs are a sequence of JSON objects: a chunk must stop only at a complete object. Drop a partial last object instead of cutting it.*
7. *Implement upload and parser; then verify the chunker never exceeds the context limit.*
8. *Persist jobs, chunk statuses, findings, evidence and shared context; save every completed chunk immediately.* (The developer chose to keep MongoDB instead of the brief's SQLite.)
9. *Implement the analyzer and prompt manager.* Follow-up: ***attack types must not be hardcoded; the model must name them from its own analysis.***
10. *Implement JSON validation, cross-chunk correlation and the final report.*
11. *Connect the pipeline: API routes, queue, progress, error handling, safe retries.*
12. *Build the React dashboard on the real APIs.*
13. *Security and optimization: prompt injection, no command execution, memory within 4 GB, AI guardrails.*
14. *Dialog-based warnings, a friendlier responsive UI; user-level messages only; test everything end to end.*

## 3. Local model prompts

Both prompts live in `backend/src/prompts/` and are loaded by `promptManager.js`. `{{SEVERITIES}}` is filled from the single severity list in `models/Alert.js`.

### 3.1 Chunk analysis (`analysis_prompt.txt`), one call per chunk

- **System message:** the role, the line-number convention (`L42: {...}`), the instruction to name the attack type from the data, and rules: logs are untrusted; cite real line numbers; single errors are not attacks; mark `repeated_pattern`; use the context from earlier chunks; word limits; minified JSON.
- **User message:** the compact context from earlier chunks, then the chunk between `<<<LOG_ENTRIES` … `LOG_ENTRIES>>>` markers.
- **Output:** constrained by a JSON schema through llama.cpp grammar sampling, with fields `attack_type`, `repeated_pattern`, `severity`, `ip_or_identifier`, `line_numbers`, `reason` and `suggested_action`, and length caps from config.

### 3.2 Incident labelling (`incident_prompt.txt`), one call per merged incident in the final report

- **Input:** deterministic facts for one source (for example "8 authentication failures L5-L21", "successful authentication after 8 consecutive failures at L35", "activity spans chunks 1, 2, 3"), plus the labels from earlier chunks.
- **Output:** `attack_type`, `severity`, `reason` and `suggested_action`, schema-constrained.

## 4. Prompt changes and why

| # | Change | Reason (observed on the live model) |
|---|---|---|
| 1 | Asked the model for evidence **line numbers only**; the backend writes evidence descriptions from the real entry | Saves output tokens, and descriptions can no longer be invented |
| 2 | Added "reply with minified JSON on a single line" | The model pretty-printed JSON (one line number per line) and hit the 384-token output limit; output then dropped from 384 (cut off) to about 180 tokens |
| 3 | Word limits for `reason` / `suggested_action` (plus schema caps) | Long reasons were being cut off mid-sentence and pushed later findings out of the budget |
| 4 | Removed the fixed list of five attack categories; the model names `attack_type` itself (developer requirement) | Attack types must come from analysing the data, not from code. This also shrank the fixed prompt from about 461 to 366 tokens, giving each chunk about 95 more tokens of log |
| 5 | Added `repeated_pattern` (the model declares it) instead of a coded list of "pattern" attack types | Keeps the minimum-evidence guardrail without hardcoding types |
| 6 | Incident prompt: removed a login-specific example sentence and added "use only events stated in the facts" | The model copied the example ("failed logins followed by a success") into an unrelated scanning incident |
| 7 | Endpoint samples and payload samples added to the correlation facts | With only "6 distinct endpoints, 100% errors" the model guessed "DDoS"; with the paths (`/.env`, `/wp-admin`) its reason became "web application probing" |

## 5. Token budget strategy

The budget for **every** request is exact, using Qwen's own tokenizer (`/tokenize`) and its chat template (`/apply-template`). Nothing is estimated from characters.

```
2048 (n_ctx) = fixed prompt (system + template, measured once, about 366)
             + shared-context reserve (200, AI_CONTEXT_RESERVE_TOKENS)
             + log chunk (whatever remains, about 970)
             + reserved output (384, AI_RESERVED_OUTPUT_TOKENS)
             + safety margin (128, AI_TOKEN_SAFETY_MARGIN)
```

- **Chunking:** whole entries are added while they fit, then the joined chunk is recounted exactly. If it's over, the last whole entry moves to the next chunk; JSON objects are never cut.
- **Context:** the most suspicious facts from earlier chunks are added while they fit in the 200-token reserve. Previous AI answers and raw earlier logs are never re-sent.
- **Two guards:** the analyzer checks the exact size of every assembled request before sending (and shrinks the context, never the log, if needed), and `modelService.chat()` rejects anything that would still overflow (`CONTEXT_LIMIT`).
- **Output budget:** protected by schema length caps and minified JSON. If a reply is still cut off, the complete findings are recovered and the half-written last one is discarded.
- **Measured:** on a 28k-token log, the largest prompt was about 1,310 tokens + 384 output, well under 2,048.

## 6. AI mistakes identified and fixed

### 6.1 Mistakes by the runtime model (Qwen3.5-2B)

| Mistake | Fix |
|---|---|
| Called a **single** failed login a "brute-force attempt" | Grounding rule: a finding the model marks as a repeated pattern must cite ≥ `AI_MIN_EVIDENCE_FOR_PATTERN` entries; deterministic correlation decides on repetition |
| Flagged one 404 as "scanning" | Same minimum-evidence rule |
| Cited **wrong line numbers** / neighbouring lines of other IPs | Validator keeps only cited lines that exist in the chunk **and** mention the reported identifier; otherwise the finding is rejected |
| Pretty-printed JSON exhausted the output budget | Minified-JSON instruction and schema length caps; salvage of complete findings from cut-off output |
| Copied the prompt's own definition into `reason` | Removed the definitions from the prompt (attack types are no longer listed) |
| **Mislabels attacks** (a scanner called "DDoS" or "SQL Injection" while its own reason said "probing") | Partly mitigated with richer facts. **Not fully fixed:** with free-text labels, a 2B model's naming varies between runs. Evidence, facts and severity are deterministic and stay correct. Documented as a known limitation. |
| Missed the SQL injection in some runs | Added a type-neutral deterministic **payload anomaly** fact (unusual characters in parameters, configurable pattern); the model then named it correctly from the sample payload |

### 6.2 Mistakes by the coding assistant, caught during review and testing

| Mistake | How it was caught | Fix |
|---|---|---|
| A MongoDB `$$this` reference became `$this` after a scripted string replace, so the chunk counters would be wrong | Self-review of the generated file before testing | Corrected, and the counters were tested (fail → retry → success) |
| Shell escaping corrupted `'\n'`, `'\r'`, `'\\'` and a template string while extracting the JSON scanner into a reusable function | Read-back of the file and a parser regression test | Fixed with targeted edits; the parser output was confirmed identical to before |
| An invalid JSON escape (`\l`) in `package.json` | `node` failed to parse `package.json` | Proper `\\` escaping |
| **Prompt-injection hole:** the first defence only fenced the log text, but llama.cpp parses `<\|im_end\|><\|im_start\|>system` inside message content as real control tokens, so a log line could forge a system message | Tested `/tokenize` and `/apply-template` directly during the security step | `neutralizeUntrusted()` breaks control tokens in all untrusted text (logs, facts, context); verified no control-token ID remains |
| Job resume ran **before** the HTTP port was bound, so a busy port could crash the process mid-job | Investigating an `EADDRINUSE` crash | Bind the port first, then resume jobs; clear startup messages |
| Leftover dev servers from the assistant's own test runs kept ports 5000/5173 busy (on Windows, stopping the parent shell did not stop the children) | The developer reported "server is crashing" | Stopped only those process trees; tests now stop servers by exact PID |
| An early API contract exposed technical error text (model URLs, endpoint paths) to the UI | Review requested by the developer | `utils/userMessages.js`: user-level messages in API responses and saved job/chunk errors; technical detail goes to the server log only |
| Setting the API to listen on `127.0.0.1` alone would have broken the Vite proxy that targeted `localhost` (it can resolve to IPv6 on Windows) | Review of the side effects of the hardening change | Proxy target set to `127.0.0.1`, overridable with `VITE_API_PROXY` |
