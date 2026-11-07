// security_utils: guardrails between untrusted log content, the model and the user.
//
// Input side (log text, facts derived from logs):
//  - neutralizeUntrusted(): breaks chat-template control tokens such as
//    "<|im_end|><|im_start|>system" so a log line cannot close the user turn
//    and forge a system message (llama.cpp parses these strings as special
//    tokens), breaks reasoning tags, and strips control characters.
//  - detectInjection(): flags text that addresses an AI instead of describing
//    an event; such entries are reported as observed facts (log injection).
//
// Output side (model answers):
//  - sanitizeModelText(): removes control tokens, markup and control chars and
//    caps length before anything is stored or shown.
//  - Model output that itself contains instruction-like text is treated as a
//    possibly successful injection and rejected by the validator.
//
// Nothing in this project executes log or model content: there is no shell,
// eval or dynamic code path; suggested actions are stored and shown as text.
import config from '../config/config.js';

const sec = config.security;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function neutralizeUntrusted(text) {
  if (!text) return '';
  return String(text)
    .replace(CONTROL_CHARS, ' ')
    .replace(sec.controlTokenPattern, (m) => `< ${m.slice(1, -1)} >`) // "<|im_end|>" -> "< |im_end| >"
    .replace(sec.reasoningTagPattern, (m) => m.replace('<', '< '));
}

export const detectInjection = (text) => Boolean(text) && sec.injectionPattern.test(String(text));

export function sanitizeModelText(text, maxLength) {
  const clean = String(text ?? '')
    .replace(sec.controlTokenPattern, ' ')
    .replace(sec.reasoningTagPattern, ' ')
    .replace(/<[^>]{1,200}>/g, ' ') // markup is never valid in a finding
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return maxLength && clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export default { neutralizeUntrusted, detectInjection, sanitizeModelText };
