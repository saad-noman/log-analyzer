// correlation: deterministic cross-chunk state, independent of the model.
//
// Every parsed entry (of every chunk, even one whose AI call failed) updates
// a profile per actor - each IP and each account. Profiles hold exact counts
// plus capped lists of original line numbers, so evidence spanning many
// chunks is never lost and never depends on the model's memory.
//
// From the profiles we derive BEHAVIOUR SIGNALS - observed facts such as
// "6 authentication failures then a success" or "probed 12 endpoints, 90%
// errors". Signals are never attack names: naming the attack is left to the
// model, which receives these facts as compact context.
//
// State is plain JSON (arrays, no IP/path object keys) so it can be stored in
// MongoDB after every chunk and resumed later.
import config from '../config/config.js';
import { detectInjection } from '../utils/security.js';

const cfg = config.correlation;

export function createState() {
  return { actors: [], processedChunks: [], entries: 0 };
}

// --------------------------------------------------------------------------
// Entry classification (generic log semantics, configurable vocabulary)
// --------------------------------------------------------------------------
function classify(entry) {
  const f = entry.fields || {};
  const status = Number.parseInt(f.status, 10);
  const statusClass = Number.isInteger(status) && status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : null;
  // All VALUES of the entry (keys stripped), so outcome fields with any name
  // (e.g. "auth_result":"invalid_password") are considered, not only mapped ones.
  const descriptor = entry.kind === 'json' ? entry.text.replace(/"(?:[^"\\]|\\.)*"\s*:/g, ' ') : entry.text;
  const isAuth = cfg.authContextPattern.test(descriptor) || cfg.authFailureStatuses.includes(status);
  const failure = cfg.authFailureStatuses.includes(status) || (isAuth && cfg.authFailurePattern.test(descriptor));
  const success = isAuth && !failure && (cfg.authSuccessPattern.test(descriptor) || statusClass === '2xx');
  const ts = Date.parse(f.timestamp);
  return { statusClass, isError: statusClass === '4xx' || statusClass === '5xx', failure, success, ts: Number.isNaN(ts) ? null : ts };
}

// --------------------------------------------------------------------------
// State update
// --------------------------------------------------------------------------
const pushCapped = (list, value, cap) => {
  if (list.length < cap) list.push(value);
};
const addUnique = (list, value, cap) => {
  if (value && !list.includes(value) && list.length < cap) list.push(value);
};

function newActor(kind, id) {
  return {
    kind, // 'ip' | 'account'
    id,
    events: 0,
    firstLine: null,
    lastLine: null,
    firstTs: null,
    lastTs: null,
    chunks: [],
    statusClasses: {},
    errors: 0,
    authFailures: 0,
    authSuccesses: 0,
    failStreak: 0, // consecutive failures not yet followed by a success
    failLines: [],
    successAfterFailures: [], // [{line, priorFailures}]
    endpoints: [], // [[path, count]]
    errorLines: [],
    payloadLines: [], // requests with unusual characters in parameters
    payloadSamples: [],
    injectionLines: [], // entries containing text addressed to an AI (log injection)
    denied: [], // [[resource, deniedCount]] resources refused to this actor (401/403)
    accessAfterDenial: [], // [{line, resource, priorDenials}] later 2xx on a refused resource
    linked: [], // accounts used by an IP / IPs used by an account
  };
}

/**
 * Applies one chunk's entries to the state. Idempotent per chunk index, so a
 * retried chunk is never counted twice. Mutates and returns `state`.
 */
export function applyChunk(state, chunkIndex, entries) {
  if (state.processedChunks.includes(chunkIndex)) return state;
  const byKey = new Map(state.actors.map((a) => [`${a.kind}|${a.id}`, a]));
  const actorFor = (kind, id) => {
    const key = `${kind}|${id}`;
    if (!byKey.has(key)) {
      const actor = newActor(kind, id);
      byKey.set(key, actor);
      state.actors.push(actor);
    }
    return byKey.get(key);
  };

  for (const entry of entries) {
    const c = classify(entry);
    const injected = detectInjection(entry.text);
    const { ip, user, endpoint } = entry.fields || {};
    const actors = [];
    if (ip) actors.push(actorFor('ip', ip));
    if (user) actors.push(actorFor('account', user));

    for (const a of actors) {
      a.events++;
      a.firstLine ??= entry.startLine;
      a.lastLine = entry.startLine;
      if (c.ts !== null) {
        a.firstTs ??= c.ts;
        a.lastTs = c.ts;
      }
      if (!a.chunks.includes(chunkIndex)) a.chunks.push(chunkIndex);
      if (c.statusClass) a.statusClasses[c.statusClass] = (a.statusClasses[c.statusClass] || 0) + 1;
      if (injected) pushCapped(a.injectionLines, entry.startLine, cfg.maxLinesPerSignal);
      if (c.isError) {
        a.errors++;
        pushCapped(a.errorLines, entry.startLine, cfg.maxLinesPerSignal);
      }
      if (endpoint) {
        const path = endpoint.split('?')[0];
        const known = a.endpoints.find((e) => e[0] === path);
        if (known) known[1]++;
        else if (a.endpoints.length < cfg.maxTrackedEndpoints) a.endpoints.push([path, 1]);
        if ((endpoint.match(cfg.payloadCharPattern) || []).length >= cfg.payloadMinMatches) {
          pushCapped(a.payloadLines, entry.startLine, cfg.maxLinesPerSignal);
          addUnique(a.payloadSamples, endpoint.slice(0, cfg.payloadSampleChars), cfg.maxPayloadSamples);
        }
      }
      // Resource-level access control: a later success on a resource that was
      // refused to the same actor (works for any endpoint, not only logins).
      if (endpoint) {
        const resource = endpoint.split('?')[0];
        a.denied ??= [];
        a.accessAfterDenial ??= [];
        const refused = a.denied.find((d) => d[0] === resource);
        if (cfg.authFailureStatuses.includes(Number.parseInt(entry.fields.status, 10))) {
          if (refused) refused[1]++;
          else if (a.denied.length < cfg.maxTrackedEndpoints) a.denied.push([resource, 1]);
        } else if (c.statusClass === '2xx' && refused && refused[1] >= cfg.minRepeats) {
          pushCapped(a.accessAfterDenial, { line: entry.startLine, resource, priorDenials: refused[1] }, cfg.maxLinesPerSignal);
          refused[1] = 0; // a new run of denials is needed for the next report
        }
      }
      if (c.failure) {
        a.authFailures++;
        a.failStreak++;
        pushCapped(a.failLines, entry.startLine, cfg.maxLinesPerSignal);
      } else if (c.success) {
        a.authSuccesses++;
        if (a.failStreak >= cfg.minRepeats) a.successAfterFailures.push({ line: entry.startLine, priorFailures: a.failStreak });
        a.failStreak = 0;
      }
    }
    // Link IP <-> account (e.g. one IP trying many accounts, or vice versa).
    if (ip && user) {
      addUnique(actorFor('ip', ip).linked, user, cfg.maxLinked);
      addUnique(actorFor('account', user).linked, ip, cfg.maxLinked);
    }
  }

  state.entries += entries.length;
  state.processedChunks.push(chunkIndex);
  return state;
}

// --------------------------------------------------------------------------
// Behaviour signals (observed facts with line evidence)
// --------------------------------------------------------------------------
const median = (values) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const range = (lines) => (lines.length > 1 ? `L${lines[0]}-L${lines[lines.length - 1]}` : `L${lines[0]}`);
const label = (a) => `${a.kind === 'ip' ? 'IP' : 'Account'} ${a.id}`;

// Robust baseline of one behaviour feature across the actors of a file.
// Median + MAD resist the attacker's own extreme value (unlike mean + stddev).
function baseline(values) {
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  const meanAd = deviations.length ? deviations.reduce((s, d) => s + d, 0) / deviations.length : 0;
  return { med, mad, meanAd, n: values.length };
}
// Modified z-score (Iglewicz & Hoaglin): (x - median) / (MAD / 0.6745).
// When more than half the actors are identical MAD is 0; the standard fallback
// scale is 1.2533 * mean absolute deviation. The scale is never smaller than a
// share of the median, so near-identical populations (e.g. request rates of
// 0.31 vs 0.33/min) do not turn tiny differences into "anomalies".
function isOutlier(value, b) {
  if (value <= b.med) return false;
  let scale = b.mad > 0 ? b.mad / 0.6745 : 1.2533 * b.meanAd;
  scale = Math.max(scale, cfg.outlierMinRelativeScale * b.med);
  return scale === 0 ? true : (value - b.med) / scale >= cfg.outlierZ;
}
const ratePerMin = (a) => (a.firstTs !== null && a.lastTs > a.firstTs ? a.events / ((a.lastTs - a.firstTs) / 60000) : null);

/**
 * Derives signals for every actor. `weight` ranks how strongly a signal
 * points to malicious behaviour (used only for ordering and severity floors).
 * @returns {Array<{actor:object, signals:Array<{name:string, fact:string, lines:number[], weight:number}>}>}
 */
export function deriveSignals(state) {
  // Per actor kind (IPs vs accounts), baselines of each behaviour feature in THIS file.
  const baselines = {};
  for (const kind of ['ip', 'account']) {
    const group = state.actors.filter((a) => a.kind === kind);
    const rates = group.map(ratePerMin).filter((r) => r !== null);
    baselines[kind] = {
      population: group.length,
      events: baseline(group.map((a) => a.events)),
      failures: baseline(group.map((a) => a.authFailures)),
      endpoints: baseline(group.map((a) => a.endpoints.length)),
      errors: baseline(group.map((a) => a.errors)),
      rate: rates.length ? baseline(rates) : null,
    };
  }
  const out = [];

  for (const a of state.actors) {
    const signals = [];
    const b = baselines[a.kind];
    const comparable = b.population >= cfg.minPopulation; // enough actors for a baseline
    const linkedNote = a.linked.length ? ` (${a.kind === 'ip' ? 'accounts' : 'IPs'}: ${a.linked.slice(0, 5).join(', ')}${a.linked.length > 5 ? ', …' : ''})` : '';

    // Failures: unusual for this file (or, without a baseline, a repeated run).
    if (a.authFailures >= cfg.minRepeats && (!comparable || isOutlier(a.authFailures, b.failures))) {
      signals.push({ name: 'repeated_auth_failures', fact: `${a.authFailures} authentication failures ${range(a.failLines)}${linkedNote}${comparable ? ` (typical in this log: ${b.failures.med})` : ''}`, lines: a.failLines, weight: 2 });
    }
    if (a.successAfterFailures.length) {
      const s = a.successAfterFailures;
      signals.push({
        name: 'success_after_failures',
        fact: `successful authentication after ${s[0].priorFailures} consecutive failures at ${s.map((x) => `L${x.line}`).join(', ')}`,
        lines: s.map((x) => x.line),
        weight: 3, // possible account compromise: strongest indicator
      });
    }
    // Breadth: many more distinct resources AND more errors than other actors
    // of this file (probing). Without a baseline: repeated errors on many resources.
    const errorRatio = a.events ? a.errors / a.events : 0;
    const broad = comparable
      ? a.endpoints.length >= cfg.minRepeats && isOutlier(a.endpoints.length, b.endpoints) && isOutlier(a.errors, b.errors)
      : a.endpoints.length >= cfg.minRepeats && a.errors >= cfg.minRepeats && errorRatio >= cfg.breadthMinErrorRatio;
    if (broad) {
      const sample = a.endpoints.slice(0, cfg.maxPayloadSamples + 3).map((e) => e[0]).join(', ');
      signals.push({ name: 'endpoint_breadth', fact: `requested ${a.endpoints.length} distinct endpoints (${sample}${a.endpoints.length > cfg.maxPayloadSamples + 3 ? ', …' : ''}), ${Math.round(errorRatio * 100)}% errors ${range(a.errorLines)}`, lines: a.errorLines, weight: 2 });
    }
    if (a.payloadLines.length) {
      signals.push({
        name: 'payload_anomaly',
        fact: `${a.payloadLines.length} request(s) with unusual characters in parameters, e.g. ${a.payloadSamples.map((p) => JSON.stringify(p)).join(', ')} ${range(a.payloadLines)}`,
        lines: a.payloadLines,
        weight: 2,
      });
    }
    if (a.accessAfterDenial?.length) {
      const x = a.accessAfterDenial;
      signals.push({
        name: 'access_after_denial',
        fact: `access granted to ${[...new Set(x.map((v) => v.resource))].join(', ')} after ${x[0].priorDenials} denied attempts on the same resource at ${x.map((v) => `L${v.line}`).join(', ')}`,
        lines: x.map((v) => v.line),
        weight: 3, // possible unauthorized access
      });
    }
    if (a.injectionLines?.length) {
      signals.push({ name: 'embedded_instructions', fact: `${a.injectionLines.length} entry(ies) contain instructions addressed to an AI or automation (possible log injection) ${range(a.injectionLines)}`, lines: a.injectionLines, weight: 2 });
    }
    // Volume / rate: far more events, or a far higher request rate, than the
    // other actors of this file (needs a baseline to compare with).
    const rate = ratePerMin(a);
    // A high rate only counts with more activity than is typical here (a few
    // quick requests are not a flood).
    const burst = rate !== null && b.rate && a.events > b.events.med && isOutlier(rate, b.rate);
    const heavy = comparable && a.events >= cfg.minRepeats && (isOutlier(a.events, b.events) || burst);
    if (heavy) {
      const rateNote = rate !== null ? `, ${rate.toFixed(1)}/min vs typical ${b.rate ? b.rate.med.toFixed(1) : '?'}/min` : '';
      signals.push({ name: 'volume_outlier', fact: `${a.events} events vs typical ${b.events.med} per ${a.kind === 'ip' ? 'IP' : 'account'}${rateNote} L${a.firstLine}-L${a.lastLine}`, lines: [a.firstLine, a.lastLine], weight: 2 });
    }
    if (signals.length && a.chunks.length > 1) {
      signals.push({ name: 'spans_chunks', fact: `activity spans chunks ${a.chunks.map((c) => c + 1).join(', ')}`, lines: [], weight: 1 });
    }
    if (signals.length) out.push({ actor: a, signals });
  }

  const score = (x) => x.signals.reduce((s, g) => s + g.weight, 0);
  return out.sort((x, y) => score(y) - score(x) || y.actor.events - x.actor.events);
}

/**
 * Compact context lines for the next model call, most suspicious first.
 * tokenManager.fitContext() keeps as many as fit in the context reserve.
 */
export function contextItems(state) {
  return deriveSignals(state).map(({ actor, signals }) => `${label(actor)}: ${signals.map((s) => s.fact).join('; ')}`);
}

export default { createState, applyChunk, deriveSignals, contextItems };
