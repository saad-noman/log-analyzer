import { ApiError } from './api.js';

// Turns backend/API errors into user-friendly dialog content.
// Codes come from the backend error contract ({ error: { code, message } }).
const GUIDE = {
  NETWORK_ERROR: { title: 'Backend not reachable', hint: 'Start the API with "npm run dev" in the project folder, then try again.' },
  UNSUPPORTED_FILE_TYPE: { title: 'Unsupported file type', hint: 'Choose a plain-text log file with an allowed extension.' },
  LIMIT_FILE_SIZE: { title: 'File too large', hint: 'Split the log or raise MAX_UPLOAD_MB in .env.' },
  BINARY_FILE: { title: 'Not a text file', hint: 'The file contains binary data. Upload the original text log.' },
  INVALID_ENCODING: { title: 'Unreadable text encoding', hint: 'Save the log as UTF-8 and upload it again.' },
  EMPTY_FILE: { title: 'Empty file', hint: 'The selected file has no content.' },
  NO_LOG_ENTRIES: { title: 'No log entries found', hint: 'The file has no complete JSON objects or text lines to analyse.' },
  ANALYSIS_IN_PROGRESS: { title: 'Analysis already running', hint: 'Wait for the current analysis to finish.' },
  NOT_RUNNING: { title: 'Already finished', hint: 'This analysis is no longer queued or running.' },
  NOTHING_TO_RETRY: { title: 'Nothing to retry', hint: 'Every chunk of this analysis completed successfully.' },
  NOTHING_TO_ANALYZE: { title: 'Nothing fits the model', hint: 'Every entry is larger than one model request can hold.' },
  REPORT_NOT_READY: { title: 'Report not ready yet', hint: 'The report appears automatically when the analysis finishes.' },
  UNAVAILABLE: { title: 'Local model offline', hint: 'Start the model with "npm run model" and try again.' },
  MODEL_OFFLINE: { title: 'Local model offline', hint: 'Start the model with "npm run model" and try again.' },
  LOG_GONE: { title: 'Log file missing', hint: 'Upload the log again and start a new analysis.' },
  CONTEXT_LIMIT: { title: 'Entry too large', hint: 'A log entry is larger than one AI request can hold.' },
  BAD_RESPONSE: { title: 'Unusable AI answer', hint: 'Retry the analysis; completed chunks are kept.' },
  NO_FILE: { title: 'No file selected', hint: 'Choose a .log or .txt file first.' },
  NOT_FOUND: { title: 'Not found', hint: 'It may have been deleted. Refresh the page.' },
  INTERNAL_ERROR: { title: 'Server problem', hint: 'Please try again. If it keeps happening, restart the backend.' },
  TIMEOUT: { title: 'Local model timed out', hint: 'The CPU may be busy. Try again in a moment.' },
};

const BY_STATUS = [
  [503, { title: 'Service unavailable', hint: 'The local model or database is not ready.' }],
  [404, { title: 'Not found', hint: 'It may have been deleted. Refresh the page.' }],
  [409, { title: 'Action not possible right now', hint: '' }],
  [400, { title: 'Invalid request', hint: '' }],
];

/**
 * User-level dialog content only: never codes, URLs or raw exception text.
 * API messages are already user-level (the backend sanitizes them); any other
 * exception gets a generic sentence.
 * @returns {{title:string, message:string, hint:string, tone:'error'|'warning'}}
 */
export function describeError(err) {
  const isApi = err instanceof ApiError;
  const code = isApi ? err.code : null;
  const known = code && (GUIDE[code] || Object.entries(GUIDE).find(([k]) => code.includes(k))?.[1]);
  const byStatus = BY_STATUS.find(([s]) => s === err?.status)?.[1];
  const info = known || byStatus || { title: 'Something went wrong', hint: 'Please try again. If it keeps happening, restart the application.' };
  // 4xx are user-correctable warnings; network/5xx are errors.
  const tone = isApi && err.status >= 400 && err.status < 500 ? 'warning' : 'error';
  const message = isApi ? err.message : 'An unexpected problem occurred in the application.';
  return { title: info.title, message: message === info.hint ? '' : message, hint: info.hint, tone };
}
