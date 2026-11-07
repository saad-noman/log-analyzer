import { useHealth } from '../common/health.jsx';
import { Notice } from '../common/ui.jsx';

// Readiness of the local stack (shared health poll).
export default function SystemStatus() {
  const { health } = useHealth();
  if (!health) return <section className="card"><h2>System status</h2><p className="muted">Checking…</p></section>;
  const m = health.model || {};
  const r = health.resources;
  const items = [
    { label: 'Backend API', ok: health.reachable !== false, detail: health.reachable === false ? 'not reachable' : 'online' },
    { label: 'Database', ok: Boolean(health.database), detail: health.database ? 'connected' : 'not connected' },
    { label: 'Local model', ok: Boolean(m.ok), detail: m.ok ? `context ${m.serverContext} tokens` : 'offline' },
  ];
  const memPct = r ? Math.min(100, Math.round((r.totalMb / r.limitMb) * 100)) : null;
  return (
    <section className="card">
      <h2>System status</h2>
      <ul className="status-list">
        {items.map((i) => (
          <li key={i.label}>
            <span className={`dot ${i.ok ? 'ok' : 'bad'}`} />
            <span>{i.label}</span>
            <span className="muted small">{i.detail}</span>
          </li>
        ))}
      </ul>
      {r && (
        <div className="memory">
          <div className="row between small">
            <span>Memory (model + backend + database)</span>
            <span className={r.nearLimit ? 'warn-text' : 'muted'}>{r.totalMb} / {r.limitMb} MB</span>
          </div>
          <div className="progress thin"><div className={`bar ${r.nearLimit ? 'warn' : ''}`} style={{ width: `${memPct}%` }} /></div>
        </div>
      )}
      {!m.ok && health.reachable !== false && <Notice tone="warning">Analysis needs the local model. Run <code>npm run model</code>.</Notice>}
      {r?.nearLimit && <Notice tone="warning">Memory use is close to the {r.limitMb} MB limit.</Notice>}
    </section>
  );
}
