import { useState } from 'react';
import SeveritySummary from './SeveritySummary.jsx';
import FindingsTable from './FindingsTable.jsx';
import { api } from '../../services/api.js';
import { Notice } from '../common/ui.jsx';

// Full consolidated report (GET /api/reports/:id). Used by the analysis and alerts pages.
export default function ReportView({ report }) {
  const [severity, setSeverity] = useState(null);
  const s = report.summary;
  return (
    <section className="card">
      <div className="row between">
        <div>
          <h2>Security report{report.log?.originalName ? ` · ${report.log.originalName}` : ''}</h2>
          <p className="muted small">
            {s.totalFindings} finding(s) · {s.entriesAnalyzed} entries · {s.completedChunks}/{s.totalChunks} chunks · {s.chunkFindings} chunk-level AI finding(s) merged · {s.actorsTracked} IPs/accounts correlated
          </p>
        </div>
        <a className="button secondary" href={api.reportDownloadUrl(report.analysisId)}>Download JSON</a>
      </div>
      {s.failedChunks?.length > 0 && (
        <Notice tone="warning" title="Partial AI coverage">
          {s.failedChunks.length} chunk(s) were not analysed by the model ({s.failedChunks.map((c) => `L${c.startLine}–${c.endLine}`).join(', ')}). Their entries were still used by the deterministic correlation.
        </Notice>
      )}
      {s.invalidFindings > 0 && <p className="muted small">{s.invalidFindings} finding(s) failed validation and were excluded.</p>}
      <SeveritySummary bySeverity={s.bySeverity} active={severity} onSelect={setSeverity} />
      <FindingsTable findings={report.findings} severity={severity} />
    </section>
  );
}
