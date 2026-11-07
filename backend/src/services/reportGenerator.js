// report_generator: merges chunk findings and deterministic behaviour signals
// into ONE evidence-based report for the whole file.
//
//  1. Incidents
//     - AI chunk findings are grouped by identifier, then by similarity of the
//       model's own attack labels (word overlap), so the same attack seen in
//       several chunks becomes one incident while different attacks by the
//       same source stay separate.
//     - Each actor's deterministic signals join the incident of that actor
//       with the most shared evidence lines (or form their own incident).
//     - Incidents sharing most evidence lines (e.g. IP 1.2.3.4 and account
//       admin describing the same login attempts) are merged.
//  2. Labelling: the model names the attack of each incident from the merged
//     facts (short, budget-checked call). If it fails, the most common chunk
//     label is used, or a factual description when there is none.
//  3. Severity = max(model severity, chunk severities, floor implied by the
//     strongest observed signal); a success after repeated failures => High.
//  4. Evidence: union of all lines, capped, always keeping key lines.
//  5. Strict validation, idempotent save as stage 'final', summary.
import config from '../config/config.js';
import Alert, { SEVERITIES } from '../models/Alert.js';
import model from './modelService.js';
import tm from './tokenManager.js';
import prompts from './promptManager.js';
import validator from './jsonValidator.js';
import { deriveSignals } from './correlation.js';
import { describeEntry } from './logParser.js';
import logger from '../utils/logger.js';

const rcfg = config.report;
const sevRank = (s) => SEVERITIES.indexOf(s);
const maxSeverity = (...list) => list.filter((s) => sevRank(s) >= 0).sort((a, b) => sevRank(b) - sevRank(a))[0] ?? SEVERITIES[0];
// Signal weight (1..3, see correlation) maps onto the severity scale.
const severityFloor = (signals) => SEVERITIES[Math.min(Math.max(0, ...signals.map((s) => s.weight - 1)), SEVERITIES.length - 1)];

const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.min(a.size, b.size);
};

// ---------------------------------------------------------------------------
// 1. Incidents
// ---------------------------------------------------------------------------
function newIncident(id) {
  return { ids: new Set([id]), primaryId: id, ai: [], signals: [], lines: new Set(), keyLines: new Set(), aiEvidence: new Map() };
}
function addAi(incident, f) {
  incident.ai.push(f);
  for (const e of f.evidence) {
    incident.lines.add(e.line_number);
    incident.aiEvidence.set(e.line_number, e.description);
  }
}

function buildIncidents(aiFindings, signalSets) {
  const incidents = [];

  // AI findings: same identifier + similar label => same incident.
  for (const f of aiFindings) {
    const id = f.ip_or_identifier;
    const match = incidents.find((i) => i.ids.has(id) && i.ai.some((g) => similarity(g.attack_type, f.attack_type) >= rcfg.typeSimilarity));
    if (match) addAi(match, f);
    else {
      const inc = newIncident(id);
      addAi(inc, f);
      incidents.push(inc);
    }
  }

  // Deterministic signals join the best-overlapping incident of the same actor.
  for (const { actor, signals } of signalSets) {
    const lines = new Set(signals.flatMap((s) => s.lines));
    const candidates = incidents.filter((i) => i.ids.has(actor.id));
    const best = candidates.sort((a, b) => overlap(lines, b.lines) - overlap(lines, a.lines))[0];
    const inc = best && (overlap(lines, best.lines) > 0 || candidates.length === 1) ? best : newIncident(actor.id);
    if (!incidents.includes(inc)) incidents.push(inc);
    inc.signals.push(...signals.map((s) => ({ ...s, actor: `${actor.kind === 'ip' ? 'IP' : 'Account'} ${actor.id}`, actorKind: actor.kind })));
    if (actor.kind === 'ip') inc.primaryId = actor.id; // prefer the IP as identifier
    for (const s of signals) for (const l of s.lines) inc.lines.add(l);
    // Lines of the strongest indicators (e.g. success after failures, access after denial) are always kept as evidence.
    const strongest = Math.max(...signals.map((x) => x.weight));
    for (const s of signals.filter((x) => x.weight === strongest)) for (const l of s.lines) inc.keyLines.add(l);
  }

  // Merge incidents that describe the same activity (mostly shared lines).
  for (let i = 0; i < incidents.length; i++) {
    for (let j = incidents.length - 1; j > i; j--) {
      if (overlap(incidents[i].lines, incidents[j].lines) >= rcfg.mergeOverlap) {
        const [a, b] = [incidents[i], incidents[j]];
        b.ids.forEach((x) => a.ids.add(x));
        b.ai.forEach((f) => addAi(a, f));
        a.signals.push(...b.signals.filter((s) => !a.signals.some((t) => t.fact === s.fact && t.actor === s.actor)));
        b.lines.forEach((l) => a.lines.add(l));
        b.keyLines.forEach((l) => a.keyLines.add(l));
        if (b.signals.some((s) => s.actorKind === 'ip') && !a.signals.some((s) => s.actorKind === 'ip' && s.actor.endsWith(a.primaryId))) a.primaryId = b.primaryId;
        incidents.splice(j, 1);
      }
    }
  }
  return incidents;
}

// ---------------------------------------------------------------------------
// 2. Labelling
// ---------------------------------------------------------------------------
function factItems(inc) {
  const facts = [...new Set(inc.signals.map((s) => `${s.actor}: ${s.fact}`))];
  const labels = [...new Set(inc.ai.map((f) => `Earlier label: ${f.attack_type} (${f.severity}) - ${f.reason}`))];
  return [...facts, ...labels];
}

function fallbackLabel(inc) {
  const counts = new Map();
  for (const f of inc.ai) counts.set(f.attack_type, (counts.get(f.attack_type) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const f = inc.ai.find((x) => x.attack_type === top[0]);
    return { attack_type: top[0], reason: f.reason, suggested_action: f.suggested_action, severity: f.severity };
  }
  // No model label at all: describe what was observed, without naming an attack.
  const strongest = [...inc.signals].sort((a, b) => b.weight - a.weight)[0];
  return {
    attack_type: `Suspicious behaviour: ${strongest.name.replaceAll('_', ' ')}`,
    reason: `Observed: ${strongest.fact}`.slice(0, rcfg.reasonMaxChars),
    suggested_action: 'Investigate the activity of this source in the cited lines',
    severity: null,
  };
}

async function labelIncident(inc, useModel) {
  if (!useModel) return { ...fallbackLabel(inc), source: 'fallback' };
  try {
    const budget = await tm.planBudget({ systemPrompt: prompts.getIncidentPrompt(), userTemplate: prompts.incidentUserTemplate(), maxOutputTokens: rcfg.labelMaxTokens });
    const facts = await tm.fitContext(factItems(inc), budget.logTokens);
    const res = await model.chat(prompts.buildIncidentMessages(facts.text), { maxTokens: rcfg.labelMaxTokens, jsonSchema: prompts.incidentSchema() });
    const parsed = validator.parseJsonResponse(res.content, 'attack_type');
    if (!parsed.items?.length) throw new Error(parsed.error || 'no label returned');
    // Same output guardrail as chunk findings (sanitize + injection check).
    const { label, error } = validator.cleanLabel(parsed.items[0], { attackType: config.ai.attackTypeMaxChars, reason: rcfg.reasonMaxChars, action: rcfg.actionMaxChars });
    if (error || !label.reason) throw new Error(error || 'label has no reason');
    return { ...label, suggested_action: label.suggested_action || 'Investigate the cited activity', source: 'ai' };
  } catch (err) {
    logger.warn(`Incident labelling failed for ${inc.primaryId}, using fallback: ${err.message}`);
    return { ...fallbackLabel(inc), source: 'fallback' };
  }
}

// ---------------------------------------------------------------------------
// 4. Evidence selection
// ---------------------------------------------------------------------------
function selectEvidence(inc, byLine) {
  const all = [...inc.lines].filter((l) => byLine.has(l) || inc.aiEvidence.has(l)).sort((a, b) => a - b);
  let chosen = all;
  if (all.length > rcfg.maxEvidence) {
    // Keep first, last and key lines, then sample the rest evenly.
    const keep = new Set([all[0], all[all.length - 1], ...inc.keyLines]);
    const rest = all.filter((l) => !keep.has(l));
    const slots = Math.max(0, rcfg.maxEvidence - keep.size);
    for (let k = 0; k < slots; k++) keep.add(rest[Math.floor((k * rest.length) / slots)]);
    chosen = [...keep].filter((l) => l !== undefined).sort((a, b) => a - b);
  }
  return chosen.map((line) => ({ line_number: line, description: byLine.has(line) ? describeEntry(byLine.get(line)) : inc.aiEvidence.get(line) }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * @param {object} p
 * @param {object} p.analysis  Analysis document
 * @param {object} p.state     correlation state (sharedContext)
 * @param {Array}  p.entries   parsed entries of the file (for evidence text)
 * @param {boolean} [p.modelAvailable=true]  false skips labelling calls
 */
export async function generateReport({ analysis, state, entries, modelAvailable = true }) {
  const byLine = validator.indexLines(entries);
  const aiFindings = await Alert.find({ analysisId: analysis._id, stage: 'chunk' }).lean();
  const signalSets = deriveSignals(state);
  const incidents = buildIncidents(aiFindings, signalSets);

  // Strongest incidents first, so model labelling goes where it matters most.
  const strength = (i) => i.signals.reduce((s, g) => s + g.weight, 0) + i.ai.reduce((s, f) => s + sevRank(f.severity) + 1, 0);
  incidents.sort((a, b) => strength(b) - strength(a));

  const finals = [];
  const invalid = [];
  for (const [n, inc] of incidents.entries()) {
    const label = await labelIncident(inc, modelAvailable && n < rcfg.maxAiLabels);
    const finding = {
      attack_type: label.attack_type,
      severity: maxSeverity(label.severity, ...inc.ai.map((f) => f.severity), inc.signals.length ? severityFloor(inc.signals) : null),
      ip_or_identifier: inc.primaryId,
      evidence: selectEvidence(inc, byLine),
      reason: label.reason,
      suggested_action: label.suggested_action,
      source: inc.signals.length ? 'correlation' : 'ai',
      // Observed when deterministic facts back it; the attack name stays a suspicion.
      certainty: inc.signals.length ? 'observed' : 'suspected',
      observed_facts: [...new Set(inc.signals.map((s) => `${s.actor}: ${s.fact}`))],
      label_source: label.source,
    };
    const errors = validator.validateFinding(finding);
    if (errors.length) invalid.push({ finding, errors });
    else finals.push(finding);
  }

  // Regenerating replaces the previous final findings (idempotent).
  await Alert.deleteMany({ analysisId: analysis._id, stage: 'final' });
  const { rejected } = await Alert.upsertMany(finals, { analysisId: analysis._id, logId: analysis.logId, stage: 'final' });

  finals.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.evidence.length - a.evidence.length);
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, finals.filter((f) => f.severity === s).length]));
  return {
    generatedAt: new Date(),
    summary: {
      totalFindings: finals.length,
      bySeverity,
      chunkFindings: aiFindings.length,
      entriesAnalyzed: state.entries,
      actorsTracked: state.actors.length,
      totalChunks: analysis.totalChunks,
      completedChunks: analysis.completedChunks,
      failedChunks: analysis.chunks.filter((c) => c.status === 'failed').map((c) => ({ index: c.index, startLine: c.startLine, endLine: c.endLine, error: c.error })),
      oversizedEntries: analysis.oversized?.length ?? 0,
      invalidFindings: invalid.length + rejected.length,
    },
    findings: finals,
  };
}

export default { generateReport };
