// Severity counts from report.summary.bySeverity (order defined by the backend).
export default function SeveritySummary({ bySeverity, active, onSelect }) {
  const levels = Object.keys(bySeverity || {}).reverse(); // most severe first
  return (
    <div className="stats">
      {levels.map((s) => (
        <button key={s} className={`stat sev-card sev-${s.toLowerCase()} ${active === s ? 'selected' : ''}`} onClick={() => onSelect?.(active === s ? null : s)} title="Filter findings">
          <span className="value">{bySeverity[s]}</span>
          <span className="label">{s}</span>
        </button>
      ))}
    </div>
  );
}
