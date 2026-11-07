import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ProgressPanel from '../components/dashboard/ProgressPanel.jsx';
import ReportView from '../components/reports/ReportView.jsx';
import { api, ACTIVE_STATUSES, POLL_INTERVAL_MS } from '../services/api.js';
import { useDialog } from '../components/common/dialog.jsx';
import { EmptyState, Spinner, useInterval } from '../components/common/ui.jsx';

// Live progress of one analysis; the report appears when it is ready.
export default function LogAnalysis() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showError, confirm, alert, toast } = useDialog();
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const lastStatus = useRef(null);

  const load = useCallback(async () => {
    try {
      const p = await api.getAnalysis(id);
      setProgress(p);
      if (p.hasReport && !ACTIVE_STATUSES.includes(p.status)) setReport(await api.getReport(id));

      // Announce the moment a running job finishes (not on first load).
      const prev = lastStatus.current;
      lastStatus.current = p.status;
      if (prev && ACTIVE_STATUSES.includes(prev) && !ACTIVE_STATUSES.includes(p.status)) {
        if (p.status === 'completed') toast('Analysis completed');
        else if (p.status === 'completed_with_errors') alert({ tone: 'warning', title: 'Completed with errors', message: `${p.failedChunks} chunk(s) could not be analysed by the model.`, hint: 'Their entries were still used by the deterministic correlation. Use "Retry failed chunks" to run them again.' });
        else if (p.status === 'failed') alert({ tone: 'error', title: 'Analysis failed', message: p.error || 'The analysis stopped.', hint: 'Completed chunks are saved. Fix the cause and retry.' });
      }
    } catch (err) {
      if (err.status === 404) setNotFound(true);
      else showError(err, 'Could not load the analysis');
    }
  }, [id, showError, toast, alert]);

  useEffect(() => {
    setReport(null);
    setNotFound(false);
    lastStatus.current = null;
    load();
  }, [load]);
  useInterval(load, POLL_INTERVAL_MS, Boolean(progress && ACTIVE_STATUSES.includes(progress.status)));

  async function retry() {
    const ok = await confirm({ title: 'Retry failed chunks?', message: 'Only failed or unfinished chunks run again. Completed chunks and their findings are kept, and nothing is duplicated.', confirmLabel: 'Retry' });
    if (!ok) return;
    setRetrying(true);
    try {
      setReport(null);
      const p = await api.retryAnalysis(id);
      lastStatus.current = p.status;
      setProgress(p);
      toast('Retry queued', 'info');
    } catch (err) {
      showError(err, 'Retry not possible');
    } finally {
      setRetrying(false);
    }
  }

  async function cancel() {
    const ok = await confirm({ tone: 'danger', title: 'Cancel this analysis?', message: 'It stops after the current chunk. Completed chunks are kept, and you can resume it later with Retry.', confirmLabel: 'Cancel analysis', cancelLabel: 'Keep running' });
    if (!ok) return;
    try {
      const p = await api.cancelAnalysis(id);
      lastStatus.current = p.status;
      setProgress(p);
      toast('Analysis cancelled', 'info');
    } catch (err) {
      showError(err, 'Could not cancel');
    }
  }

  async function remove() {
    const ok = await confirm({ tone: 'danger', title: 'Delete this analysis?', message: 'Its saved report and findings will be removed permanently.', confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.deleteAnalysis(id);
      toast('Analysis deleted');
      navigate('/reports');
    } catch (err) {
      showError(err, 'Could not delete the analysis');
    }
  }

  if (notFound) return <EmptyState icon="?" title="Analysis not found">It may have been deleted. <Link to="/reports">Open the history</Link>.</EmptyState>;
  if (!progress) return <Spinner label="Loading analysis…" />;
  const canRetry = ['failed', 'completed_with_errors', 'cancelled'].includes(progress.status);
  const isActive = ACTIVE_STATUSES.includes(progress.status);

  return (
    <div className="page">
      {isActive && <p className="muted small">You can switch to other pages while this runs; the header shows its progress and links back here.</p>}
      <ProgressPanel
        progress={progress}
        action={
          <>
            {isActive && <button className="secondary" onClick={cancel}>Cancel</button>}
            {canRetry && (
              <button onClick={retry} disabled={retrying}>{retrying ? <Spinner label="Queuing…" /> : progress.status === 'cancelled' ? 'Resume' : 'Retry failed chunks'}</button>
            )}
            {!isActive && <button className="secondary" onClick={remove}>Delete</button>}
          </>
        }
      />
      {report && <ReportView report={report} />}
    </div>
  );
}
