import { Notice, Spinner, StatusBadge, formatDuration } from '../common/ui.jsx';
import { ACTIVE_STATUSES } from '../../services/api.js';

// Live progress of one analysis, straight from GET /api/analyses/:id.
export default function ProgressPanel({ progress: p, action }) {
  const t = p.tokens || {};
  const r = p.resources;
  const active = ACTIVE_STATUSES.includes(p.status);
  return (
    <section className="card">
      <div className="row between">
        <div>
          <h2>Analysis progress</h2>
          <p className="muted small">
            {active ? <Spinner label={p.stage} /> : p.stage}
            {p.queuePosition > 0 && ` · ${p.queuePosition} job(s) ahead in the queue`}
          </p>
        </div>
        <div className="row">
          {action}
          <StatusBadge status={p.status} />
        </div>
      </div>

      <div className="progress" role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`bar ${p.failedChunks ? 'warn' : ''} ${active ? 'live' : ''}`} style={{ width: `${p.percent}%` }} />
      </div>

      <div className="stats">
        <Stat label="Total chunks" value={p.totalChunks} />
        <Stat label="Completed" value={p.completedChunks} tone="good" />
        <Stat label="Remaining" value={p.remainingChunks} />
        <Stat label="Failed" value={p.failedChunks} tone={p.failedChunks ? 'bad' : ''} />
        <Stat label="Time left (est.)" value={formatDuration(p.etaSeconds)} />
      </div>

      <div className="meta-grid small">
        <div><span className="muted">Context window</span> {t.contextSize ?? '—'} tokens</div>
        <div><span className="muted">Log tokens / chunk</span> {t.chunkLogBudget ?? '—'}</div>
        <div><span className="muted">Reserved output</span> {t.reservedOutput ?? '—'}</div>
        <div><span className="muted">Largest prompt</span> {t.maxPromptTokens ? `${t.maxPromptTokens} (avg ${t.avgPromptTokens})` : '—'}</div>
        {r && (
          <div className={r.withinLimit ? '' : 'bad'}>
            <span className="muted">Peak memory</span> {r.totalMb} / {r.limitMb} MB
            <span className="muted"> (model {r.modelMb ?? '?'} · backend {r.nodeMb} · db {r.databaseMb ?? '?'})</span>
          </div>
        )}
      </div>

      {p.error && <Notice tone="error" title="Analysis stopped">{p.error}</Notice>}
      {p.oversizedEntries?.length > 0 && (
        <Notice tone="warning">{p.oversizedEntries.length} entry(ies) were too large for one model request; they were analysed by the deterministic correlation only.</Notice>
      )}

      {p.chunks?.length > 0 && (
        <details className="chunk-details">
          <summary>Chunk details ({p.chunks.length})</summary>
          <div className="chunks">
            {p.chunks.map((c) => (
              <div key={c.index} className={`chunk ch-${c.status}`} title={c.error || `${c.findingsCount} finding(s), ${c.rejectedCount} rejected`}>
                <div className="row between"><strong>#{c.index + 1}</strong><span className="small">{c.status}</span></div>
                <span className="mono small">L{c.startLine}–{c.endLine}</span>
                <span className="muted small">{c.tokens} tokens{c.durationMs ? ` · ${Math.round(c.durationMs / 1000)}s` : ''}{c.attempts > 1 ? ` · ${c.attempts} attempts` : ''}</span>
                {c.status === 'completed' && <span className="small">{c.findingsCount} finding(s){c.rejectedCount ? `, ${c.rejectedCount} rejected` : ''}</span>}
                {c.error && <span className="bad small">{c.error}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

const Stat = ({ label, value, tone = '' }) => (
  <div className={`stat ${tone}`}>
    <span className="value">{value}</span>
    <span className="label">{label}</span>
  </div>
);
