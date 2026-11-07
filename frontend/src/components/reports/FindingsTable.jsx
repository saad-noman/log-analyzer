import { Fragment, useState } from 'react';
import { EmptyState, SeverityBadge } from '../common/ui.jsx';

// Consolidated findings; click a row for evidence, facts, reason and action.
export default function FindingsTable({ findings, severity }) {
  const [open, setOpen] = useState(null);
  const rows = severity ? findings.filter((f) => f.severity === severity) : findings;
  if (!rows.length) {
    return findings.length ? <EmptyState icon="⊘" title={`No ${severity} findings`}>Clear the filter to see all findings.</EmptyState> : <EmptyState icon="✓" title="No suspicious activity found">No evidence-backed attack was detected in this log.</EmptyState>;
  }

  return (
    <table className="responsive findings">
      <thead>
        <tr>
          <th>Severity</th>
          <th>Attack type</th>
          <th>IP / identifier</th>
          <th>Evidence lines</th>
          <th>Basis</th>
          <th aria-label="Expand" />
        </tr>
      </thead>
      <tbody>
        {rows.map((f, i) => {
          const isOpen = open === i;
          return (
            <Fragment key={`${f.ip_or_identifier}-${f.attack_type}-${i}`}>
              <tr className={`clickable ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}>
                <td data-label="Severity"><SeverityBadge severity={f.severity} /></td>
                <td data-label="Attack type"><strong>{f.attack_type}</strong></td>
                <td data-label="IP / identifier" className="mono">{f.ip_or_identifier}</td>
                <td data-label="Evidence lines" className="mono small">{f.evidence.map((e) => e.line_number).join(', ')}</td>
                <td data-label="Basis" className="small">
                  {f.certainty === 'observed' ? 'Observed facts + AI' : 'AI (suspected)'}
                  {f.label_source === 'fallback' && <span className="muted"> · fallback label</span>}
                </td>
                <td className="chevron" aria-hidden>{isOpen ? '▴' : '▾'}</td>
              </tr>
              {isOpen && (
                <tr className="detail">
                  <td colSpan={6}>
                    <div className="detail-grid">
                      <div>
                        <h4>Why it is suspicious</h4>
                        <p>{f.reason}</p>
                        <h4>Suggested action</h4>
                        <p>{f.suggested_action}</p>
                        {f.observed_facts?.length > 0 && (
                          <>
                            <h4>Observed facts (deterministic)</h4>
                            <ul>{f.observed_facts.map((x) => <li key={x}>{x}</li>)}</ul>
                          </>
                        )}
                      </div>
                      <div>
                        <h4>Evidence ({f.evidence.length})</h4>
                        <ul className="evidence">
                          {f.evidence.map((e) => (
                            <li key={e.line_number}><span className="mono line">L{e.line_number}</span> {e.description}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
