# Local AI Security Log Analyzer

A web application that analyses server log files with a **locally running language model** (Qwen3.5-2B through llama.cpp, CPU only, offline). It splits large logs into token-exact chunks that fit a **2,048-token** context, analyses them one at a time, correlates related events **across chunks** with deterministic backend logic, and produces **one consolidated, evidence-based security report**.

No cloud AI service is used. All findings come from the real model and real log data.

---

## Contents
1. [Architecture](#1-architecture)
2. [Requirements](#2-requirements)
3. [Installation and setup](#3-installation-and-setup)
4. [Local model details and configuration](#4-local-model-details-and-configuration)
5. [Usage](#5-usage)
6. [Log splitting approach and token budget](#6-log-splitting-approach-and-token-budget)
7. [Analysis, correlation and report](#7-analysis-correlation-and-report)
8. [Security and reliability](#8-security-and-reliability)
9. [Resource usage](#9-resource-usage)
10. [API reference](#11-api-reference)
11. [Known limitations](#12-known-limitations)

---

## 1. Architecture

```
React + Vite dashboard ──/api──► Express API ──► analysis queue (one job, one model request at a time)
                                    │                  │
                                    │      parse ► chunk ► [correlate ► analyse ► validate ► save] × N ► report
                                    │                  │                      │
                                 MongoDB  ◄────────────┘           llama-server (Qwen3.5-2B, Offline)
```

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 6, plain CSS (responsive, no UI framework) |
| Backend | Node.js 22.5+ (tested on 24), Express 4, Multer (disk streaming) |
| Database | MongoDB (Mongoose) |
| Local inference | llama.cpp `llama-server` (CPU build), Qwen3.5-2B Q4_K_M GGUF |
| Token counting | The model's own tokenizer and chat template (`/tokenize`, `/apply-template`) |

Backend modules (`backend/src/services/`):

| Module | Responsibility |
|---|---|
| `modelService.js` | Only module that talks to llama.cpp: exact token counts, context guard, sequential queue, timeouts and retries |
| `tokenManager.js` | Budget planning, batch token counting, context fitting, exact request verification |
| `logParser.js` | Streams the file; string-aware JSON-object scanner; preserves original line ranges; normalises fields |
| `chunker.js` | Token-exact chunks that always end on a complete entry |
| `promptManager.js` | Builds prompts; fences and neutralises untrusted text; JSON output schemas |
| `analyzer.js` | One chunk → model → validated, grounded findings |
| `jsonValidator.js` | Tolerant parsing, salvage of cut-off output, grounding, strict final-structure validation |
| `correlation.js` | Deterministic cross-chunk state per IP/account and behaviour facts |
| `reportGenerator.js` | Merges findings and facts into incidents, AI labelling, severity, final report |
| `analysisRunner.js` | Job queue, per-chunk persistence, safe retry, resume after restart |
| `progressTracker.js` | Progress view derived from saved chunk statuses |
| `resourceMonitor.js` | Measured memory of model + backend + database against the limit |
| `utils/security.js` | Prompt-injection neutralisation and detection, model-output sanitising |

---

## 2. Requirements

| Item | Notes |
|---|---|
| CPU | 2 vCPU is enough; no GPU needed |
| RAM | 4 GB total for model + backend + database (measured peak below 2 GB, §9) |
| Node.js | 22.5 or newer (tested with 24.15) |
| MongoDB | Community Server running locally |
| llama.cpp | A recent prebuilt CPU release with Qwen3.5 support |
| Model | **Qwen3.5-2B** GGUF, **Q4_K_M** quantization (about 1.31 GB file) |

---

## 3. Installation and setup

```bash
# 1. Dependencies (root, backend, frontend)
npm run install:all

# 2. llama.cpp: download a CPU release from https://github.com/ggml-org/llama.cpp/releases
#    and extract it into runtime/llama.cpp/  (this folder is git-ignored)

# 3. Model: place the GGUF file at
#    models/downloaded-model/qwen3.5-2b-Q4_K_M.gguf   (git-ignored)

# 4. Configuration: create .env in the project root (see the table in §4)

# 5. MongoDB must be running locally
```

After installation everything runs **offline**.

### Running

Use two terminals in the project root:

```bash
npm run model   # starts llama-server: ctx 2048, 2 threads, 1 slot, 127.0.0.1:8080
npm run dev     # starts the API (127.0.0.1:5000) and the dashboard (http://localhost:5173)
```

Open **http://localhost:5173**. The header and the System status card show whether the API, database and model are ready.

---

## 4. Local model details and configuration

**Model choice:** Qwen3.5-2B Q4_K_M was chosen over the 0.8B model (weaker instruction following and JSON) and Gemma 4 E2B (larger memory footprint). It loads on CPU in about 2 s and runs at about 50 tokens/s for prompts and 15 tokens/s for output with 2 threads.

**How the server is started** (`npm run model`):

```
llama-server -m models/downloaded-model/qwen3.5-2b-Q4_K_M.gguf -c 2048 -t 2 -np 1 --cache-ram 0 --host 127.0.0.1 --port 8080 --no-webui
```

| Flag | Why |
|---|---|
| `-c 2048` | The project's hard context limit |
| `-t 2` | Matches the 2 vCPU constraint |
| `-np 1` | One slot, so requests never run in parallel |
| `--cache-ram 0` | Disables the host prompt cache so memory cannot grow over time |
| `--host 127.0.0.1` | The model is reachable only from the local machine |

Qwen3.5 "thinks" by default. Every request sends `chat_template_kwargs: { enable_thinking: false }`, so the small output budget is not spent on reasoning text.

### `.env` settings (all optional unless marked)

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `5000`, `127.0.0.1` | API address (loopback only by default) |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS origin of the dashboard |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/log_analyzer` | Database |
| `AI_BASE_URL` | `http://127.0.0.1:8080` | llama-server address |
| `AI_MODEL_PATH` | — | Path of the GGUF file (documentation/health) |
| `AI_CONTEXT_SIZE` | `2048` | Context window used for every budget calculation |
| `AI_RESERVED_OUTPUT_TOKENS` | `384` | Output tokens reserved in every request |
| `AI_TOKEN_SAFETY_MARGIN` | `128` | Headroom for template/tokenizer effects |
| `AI_CONTEXT_RESERVE_TOKENS` | `200` | Tokens reserved for cross-chunk context |
| `AI_TEMPERATURE` | `0.1` | Sampling temperature |
| `AI_REQUEST_TIMEOUT_MS` | `180000` | Per-request timeout |
| `AI_MAX_RETRIES` | `2` | Retries for transient model errors |
| `AI_MAX_FINDINGS_PER_CHUNK` | `10` | Schema cap on findings per chunk |
| `AI_MIN_EVIDENCE_FOR_PATTERN` | `3` | Entries required when the model claims a repeated pattern |
| `MAX_UPLOAD_MB`, `ALLOWED_EXTENSIONS` | `25`, `.log,.txt` | Upload limits (also shown in the UI) |
| `MEMORY_LIMIT_MB` | `4096` | Limit used by the resource monitor |
| `MONGO_WIREDTIGER_CACHE_MB` | unset | Optional runtime cap of MongoDB's cache |

Further tuning variables (correlation thresholds, report limits, security patterns) are documented next to their defaults in `backend/src/config/config.js`.

---

## 5. Usage

1. **Upload** a `.log` or `.txt` file (drag and drop or browse) and click **Upload & analyse**. It is checked for type, size, binary content and encoding, then parsed. Parse issues (invalid or unterminated JSON) are reported.
2. The **analysis starts automatically** and the live progress page opens (if the local model is offline, a warning explains how to start it; the upload is kept, and **Start analysis** in the log list runs it later). The chunk plan is computed immediately, so the total number of chunks is known from the start.
3. Watch **progress**: total, completed, remaining and failed chunks, an ETA from measured chunk times, token usage and measured peak memory.
4. Read the **report**: severity summary (click to filter) and consolidated findings. Expand a finding for its reason, suggested action, deterministic observed facts and every evidence line with its original line number.
5. If chunks failed (for example the model was stopped), click **Retry failed chunks**. Completed work is kept.
6. **History** lists all analyses. Reports can be downloaded as JSON.

---

## 6. Log splitting approach and token budget

**Parsing.** The file is streamed and scanned character by character with a JSON-aware brace counter that tracks strings and escapes. It handles one object per line, objects spread over several lines, and several objects on one line. Each entry keeps its **original start and end line**. Invalid JSON is flagged and kept as text evidence. An unterminated object at the end of the file is reported and **never** sent to the model. Plain-text lines are supported as one entry per line.

**Budget of every request** (all values measured with the real tokenizer and chat template):

```
2048 = fixed prompt (~366) + context reserve (200) + log chunk (~970) + output (384) + margin (128)
```

**Chunking rule:** a chunk always ends on a complete entry.

```
{...} {...} {...}     accepted
{...} {...} {...      never produced: the last object moves to the next chunk
```

Entries are formatted as `L<start>[-<end>]: <minified JSON>` so the model can cite line numbers. Minifying also saves tokens. Whole entries are added while they fit, then the joined chunk is **recounted exactly**; if it is over the budget, the last whole entry is moved to the next chunk. A single JSON entry larger than a whole chunk is never cut: it is reported as oversized and still used by the deterministic correlation.

**Two guards:** the exact size of each assembled request is verified before sending (the context is shrunk if needed, never the log), and `modelService` rejects anything that would still overflow.

---

## 7. Analysis, correlation and report

**Per chunk** (sequential): the deterministic correlation state is updated with the chunk's entries, then the model receives the chunk plus the most suspicious facts so far (within the 200-token reserve). The answer is constrained by a JSON schema and validated:
- cited lines must exist in the chunk and mention the reported identifier;
- a finding the model calls a repeated pattern must cite enough entries;
- text fields are sanitised.

Unsupported findings are rejected and counted, not saved. Results are saved **immediately** after each chunk.

**Attack types are not hardcoded.** The model names each attack from its own analysis. Only the four severities (Low, Medium, High, Critical) are fixed, because they are the required output contract.

**Cross-chunk correlation (deterministic, type-neutral).** For every IP and account, across **all** chunks (including chunks whose model call failed), the backend records:
- authentication failures and successes, and a **success after consecutive failures**;
- distinct endpoints with error ratio (with sample paths);
- requests with unusual characters in parameters (payload samples);
- request volume against the median (with the rate per minute);
- entries containing instructions aimed at an AI;
- which chunks the activity spans.

Every fact keeps original line numbers. These are observed facts, not attack names.

**Final report:**
1. Chunk findings and facts are grouped into incidents (same identifier + similar model labels; facts join by shared evidence lines; IP and account incidents covering the same lines are merged).
2. The model labels each incident from its facts.
3. Severity is the maximum of the model's severity and a floor implied by the strongest fact (a success after repeated failures means at least High).
4. Evidence is capped while key lines are kept, and each finding is strictly validated against the required structure.

Every finding has `attack_type`, `severity`, `ip_or_identifier`, `evidence[{line_number, description}]`, `reason` and `suggested_action`, plus `observed_facts` and `certainty` (*observed* when deterministic facts back it, *suspected* when it is AI-only). This keeps facts separate from inferences.

**The required cross-chunk case** (failures in chunk 1, more failures in chunk 2, a successful login in chunk 3) becomes **one** finding with the evidence lines from all three chunks and the fact *"successful authentication after N consecutive failures at L…"*.

---

## 8. Resource usage

Measured during real analyses by the built-in resource monitor (resident memory):

| Component | Measured |
|---|---|
| llama-server (Qwen3.5-2B Q4_K_M, ctx 2048) | about 1.5–1.75 GB |
| Node.js backend | about 80–95 MB |
| MongoDB (test data) | about 56 MB |
| **Total peak** | **about 1.9 GB of 4 GB** |

Only one model request runs at a time, so there is exactly one set of model buffers. MongoDB's cache grows with data. On a shared or long-lived database, set `MONGO_WIREDTIGER_CACHE_MB` (for example `256`), or start `mongod` with `--wiredTigerCacheSizeGB 0.25`.

---

## 9. Targeted tests

| Area | Result |
|---|---|
| Malformed model JSON | Code fences, prose, bare array, single object, cut-off output (salvaged), garbage → handled without crashing; one invalid finding never discards valid ones |
| Timeouts & retries (fake model server) | 500 → timeout → success recovered in 3 attempts; a timeout with no retries leaves `TIMEOUT`; server down gives `UNAVAILABLE` |
| Persistence & safe retry | Same chunk saved twice leaves one finding (fingerprints); failed → retried chunk updates counters correctly; correlation applies each chunk once |
| Prompt-injection vector | `<|im_end|><|im_start|>system` in a log becomes plain text tokens (no control-token ID) after neutralisation |
| Upload validation | Wrong type, binary, empty, unterminated-only and two-file uploads rejected with user-level messages |
| API errors | Unknown routes, invalid IDs and invalid JSON return plain messages, without paths or internals |
| Busy port | A second API instance exits with a clear message instead of crashing |

---

## 10. API reference

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Database, model, measured memory, upload limits |
| `POST /api/logs/upload` (multipart `file`) | Upload and parse a log |
| `GET /api/logs`, `GET/DELETE /api/logs/:id` | List, get, delete logs |
| `POST /api/analyses` `{ logId }` | Plan chunks and queue an analysis (202) |
| `GET /api/analyses/:id` | Live progress |
| `POST /api/analyses/:id/retry` | Safe retry of failed or unfinished chunks |
| `GET /api/analyses/:id/findings?stage=chunk\|final` | Raw chunk findings or final findings |
| `GET /api/reports/:id`, `GET /api/reports/:id/download` | Consolidated report (JSON / file) |

All errors use `{ "error": { "code", "message" } }` with user-level messages.

---
