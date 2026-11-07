// Manual check of the local model connection: `npm run test:model` (backend).
// Verifies health, real tokenizer, a real JSON response, timeout handling and
// the context-limit guard. Requires `npm run model` running in the root.
import model, { ModelError } from '../src/services/modelService.js';

const line = '2024-10-10T10:00:01Z sshd: Failed password for admin from 192.168.1.50 port 22';

const health = await model.checkHealth();
console.log('health:', health);
if (!health.ok) process.exit(1);

console.log('tokens in sample log line:', await model.countTokens(line));

const schema = {
  type: 'object',
  properties: { suspicious: { type: 'boolean' }, ip: { type: 'string' }, reason: { type: 'string', maxLength: 150 } },
  required: ['suspicious', 'ip', 'reason'],
};
const res = await model.chat(
  [
    { role: 'system', content: 'You are a security log analyst. Reply only with JSON.' },
    { role: 'user', content: `Log line:\n${line}` },
  ],
  { maxTokens: 80, jsonSchema: schema },
);
console.log('inference:', res);
console.log('parsed:', res.truncated ? 'TRUNCATED - not parsed' : JSON.parse(res.content));

try {
  await model.chat([{ role: 'user', content: 'Write a long story.' }], { maxTokens: 200, timeoutMs: 500, maxRetries: 0 });
  console.log('timeout test: FAILED (no timeout)');
} catch (e) {
  console.log('timeout test:', e instanceof ModelError ? e.code : e.message);
}

try {
  await model.chat([{ role: 'user', content: line.repeat(120) }]);
  console.log('context guard: FAILED (oversized prompt accepted)');
} catch (e) {
  console.log('context guard:', e.code, '-', e.message);
}
