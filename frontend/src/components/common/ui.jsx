// Small shared UI pieces and formatters.
import { useEffect, useRef } from 'react';

// Inline, persistent status notice (e.g. failed chunks). Errors from actions use dialogs.
export const Notice = ({ tone = 'info', title, children }) => (
  <div className={`notice tone-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    {title && <strong>{title}</strong>}
    <div>{children}</div>
  </div>
);

export const EmptyState = ({ icon = '◌', title, children }) => (
  <div className="empty">
    <span className="empty-icon" aria-hidden>{icon}</span>
    <strong>{title}</strong>
    {children && <p className="muted">{children}</p>}
  </div>
);

export const Spinner = ({ label }) => (
  <span className="spinner-wrap">
    <span className="spinner" aria-hidden /> {label}
  </span>
);

export const SeverityBadge = ({ severity }) => <span className={`badge sev-${String(severity).toLowerCase()}`}>{severity}</span>;
export const StatusBadge = ({ status }) => <span className={`badge st-${status}`}>{String(status).replaceAll('_', ' ')}</span>;

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
export const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
export const formatDate = (d) => (d ? new Date(d).toLocaleString() : '—');

// Calls fn every `ms` while `active` is true (used for polling).
export function useInterval(fn, ms, active = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
