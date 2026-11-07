// User-facing wording for errors. Technical details (URLs, endpoints, stack
// traces, field names) stay in the server log; API responses and the error
// text saved on jobs/chunks use these plain messages only.
const MESSAGES = {
  // Local model (ModelError codes)
  UNAVAILABLE: 'The local AI model is not running.',
  TIMEOUT: 'The local AI model took too long to respond.',
  CONTEXT_LIMIT: 'This part of the log is too large for one AI request.',
  HTTP_ERROR: 'The local AI model reported an error.',
  BAD_RESPONSE: 'The AI returned an answer that could not be used.',
  // Upload
  NO_FILE: 'Please choose a log file to upload.',
  LIMIT_FILE_SIZE: 'The file is larger than the allowed upload size.',
  LIMIT_FILE_COUNT: 'Please upload one file at a time.',
  LIMIT_UNEXPECTED_FILE: 'Please upload one file at a time.',
  // Requests
  NOT_FOUND: 'The requested page or item does not exist.',
  INVALID_ID: 'The requested item could not be found.',
  INVALID_JSON: 'The request could not be read. Please try again.',
  INVALID_LOG_ID: 'Please choose a valid uploaded log.',
  INTERNAL_ERROR: 'Something went wrong on the server. Please try again.',
};

/** Plain message for any error; falls back to the error's own (already user-level) text for 4xx app errors. */
export function toUserMessage(err, status = err?.status) {
  if (err?.code && MESSAGES[err.code]) return MESSAGES[err.code];
  if (err?.name === 'AppError' || (status >= 400 && status < 500 && err?.message)) return err.message;
  return MESSAGES.INTERNAL_ERROR;
}

export default { toUserMessage };
