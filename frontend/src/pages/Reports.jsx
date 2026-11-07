import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ACTIVE_STATUSES, POLL_INTERVAL_MS } from '../services/api.js';
import { useDialog } from '../components/common/dialog.jsx';
import { EmptyState, SeverityBadge, Spinner, StatusBadge, formatDate, useInterval } from '../components/common/ui.jsx';

// All analyses with their saved reports. Reports stay saved until deleted here
// (deleting an uploaded log does not delete its reports).
export default function Reports() {
  const { showError, confirm, toast, alert } = useDialog();
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.listAnalyses());
    } catch (err) {
      setList((prev) => prev ?? []);
      showError(err, 'Could not load the analyses');
    }
  }, [showError]);
  useEffect(() => {
    load();
  }, [load]);
  useInterval(load, POLL_INTERVAL_MS, Boolean(list?.some((a) => ACTIVE_STATUSES.includes(a.status))));

  const nameOf = (a) => a.logName || 'Unnamed log'; // name is saved with each analysis
  const finished = (list || []).filter((a) => !ACTIVE_STATUSES.includes(a.status));

  async function remove(a) {
    const ok = await confirm({ tone: 'danger', title: 'Delete this analysis?', message: `The report for "${nameOf(a)}" and its findings will be removed permanently.`, confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.deleteAnalysis(a.id);
      toast('Analysis deleted');
      load();
    } catch (err) {
      showError(err, 'Could not delete the analysis');
    }
  }

  async function removeAllFinished() {
    const ok = await confirm({ tone: 'danger', title: `Delete ${finished.length} finished analyses?`, message: 'All their reports and findings will be removed permanently. Running or queued analyses are kept.', confirmLabel: 'Delete all' });
    if (!ok) return;
    setBusy(true);
    let failed = 0;
    for (const a of finished) {
      try {
        await api.deleteAnalysis(a.id);
      } catch {
        failed++;
      }
    }
    setBusy(false);
    if (failed) alert({ tone: 'warning', title: 'Some analyses were kept', message: `${failed} analysis(es) could not be deleted.`, hint: 'Refresh the page and try again.' });
    else toast('Finished analyses deleted');
    load();
  }

  return (
    <div className="page">
      <section className="card">
        <div className="row between">
          <div>
            <h2>Analyses & reports</h2>
            <p className="muted small">Reports are saved until you delete them, even if the uploaded log is removed.</p>
          </div>
          {finished.length > 0 && (
            <button className="danger" onClick={removeAllFinished} disabled={busy}>{busy ? <Spinner label="Deleting…" /> : 'Delete all finished'}</button>
          )}
        </div>
        {!list ? (
          <Spinner label="Loading…" />
        ) : !list.length ? (
          <EmptyState icon="☰" title="No analyses yet">Upload a log on the <Link to="/">dashboard</Link>; its report will appear here.</EmptyState>
        ) : (
          <table className="responsive">
            <thead>
              <tr>
                <th>Log</th>
                <th>Status</th>
                <th>Findings</th>
                <th>Chunks</th>
                <th>Finished</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const active = ACTIVE_STATUSES.includes(a.status);
                const sev = a.summary?.bySeverity || {};
                return (
                  <tr key={a.id}>
                    <td data-label="Log"><Link to={`/analyses/${a.id}`}><strong>{nameOf(a)}</strong></Link><div className="muted small">{formatDate(a.createdAt)}</div></td>
                    <td data-label="Status"><StatusBadge status={a.status} /></td>
                    <td data-label="Findings">
                      {a.summary ? (
                        <span className="inline">
                          <strong>{a.summary.totalFindings}</strong>
                          {Object.keys(sev).reverse().filter((s) => sev[s]).map((s) => <span key={s} className="inline small"><SeverityBadge severity={s} />{sev[s]}</span>)}
                        </span>
                      ) : (
                        <span className="muted small">{active ? 'in progress' : 'no report'}</span>
                      )}
                    </td>
                    <td data-label="Chunks">
                      {a.completedChunks}/{a.totalChunks}
                      {a.failedChunks > 0 && <span className="bad small"> · {a.failedChunks} failed</span>}
                    </td>
                    <td data-label="Finished">{formatDate(a.finishedAt)}</td>
                    <td className="actions">
                      <Link className="button" to={`/analyses/${a.id}`}>{a.hasReport ? 'View report' : 'Open'}</Link>
                      {a.hasReport && <a className="button secondary" href={api.reportDownloadUrl(a.id)}>JSON</a>}
                      <button className="secondary" onClick={() => remove(a)} disabled={active} title={active ? 'Cancel the analysis first' : 'Delete'}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
