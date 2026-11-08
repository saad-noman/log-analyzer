# AI Usage

This document records how AI was used to build this project. It covers the coding assistant, the prompts sent to the local model, how those prompts changed, the token-budget strategy, and concrete AI mistakes that were found and fixed.

## 1. AI tools used

| Tool | Role |
|---|---|
| **Claude Code** (Anthropic), in VS Code | Coding assistant: inspected the repository, proposed the plan, wrote and refactored backend and frontend code, ran tests against the live local model (selected tests by the developer to control the behavior of the AI agent), and drafted documentation. Every change was reviewed and directed step by step by the developer. |
| **Qwen3.5-2B (Q4_K_M GGUF) via llama.cpp** | The runtime AI inside the application. It analyses log chunks and names attacks. It runs fully offline on CPU; no cloud AI API is used at runtime. |

## 2. Key coding prompts (developer → coding assistant)

The work was done in small, verifiable steps. Each prompt asked the assistant to inspect the repository first, reuse existing modules, avoid hardcoding and keep the code explainable. Only 47% Claude code session of a single context window was used to build the entire project.

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

## 4. Token budget strategy

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
