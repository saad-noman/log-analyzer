import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReportView from '../components/reports/ReportView.jsx';
import { api } from '../services/api.js';
import { useDialog } from '../components/common/dialog.jsx';
import { EmptyState, Spinner } from '../components/common/ui.jsx';

// Findings of the most recent analysis that produced a report.
export default function Alerts() {
  const { showError } = useDialog();
  const [report, setReport] = useState(undefined);

  useEffect(() => {
    (async () => {
      try {
        const latest = (await api.listAnalyses()).find((a) => a.hasReport);
        setReport(latest ? await api.getReport(latest.id) : null);
      } catch (err) {
        setReport(null);
        showError(err, 'Could not load the latest findings');
      }
    })();
  }, [showError]);

  if (report === undefined) return <Spinner label="Loading latest findings…" />;
  if (!report) return <EmptyState icon="✓" title="No completed analysis yet"><Link to="/">Upload a log</Link> to get started.</EmptyState>;
  return (
    <div className="page">
      <ReportView report={report} />
    </div>
  );
}
