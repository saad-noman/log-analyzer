import { useRef, useState } from 'react';
import { api } from '../../services/api.js';
import { useDialog } from '../common/dialog.jsx';
import { useHealth } from '../common/health.jsx';
import { Spinner, formatBytes } from '../common/ui.jsx';

// Drag-and-drop or picker upload. Files are pre-checked against the limits the
// backend reports in /api/health; the backend still validates everything.
export default function UploadPanel({ onUploaded }) {
  const { health } = useHealth();
  const { showError, alert, toast } = useDialog();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const limits = health?.limits;
  const accept = limits?.allowedExtensions?.join(',');

  async function choose(f) {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (limits && !limits.allowedExtensions.includes(ext)) {
      await alert({ tone: 'warning', title: 'Unsupported file type', message: `"${f.name}" is not accepted.`, hint: `Allowed: ${limits.allowedExtensions.join(', ')}` });
      return;
    }
    if (limits && f.size > limits.maxUploadBytes) {
      await alert({ tone: 'warning', title: 'File too large', message: `${f.name} is ${formatBytes(f.size)}.`, hint: `Maximum size is ${formatBytes(limits.maxUploadBytes)}.` });
      return;
    }
    if (f.size === 0) {
      await alert({ tone: 'warning', title: 'Empty file', message: `"${f.name}" has no content.` });
      return;
    }
    setFile(f);
  }

  async function upload() {
    setBusy(true);
    try {
      const log = await api.uploadLog(file);
      toast(`Uploaded ${log.originalName}: ${log.entryCount} entries${log.issueCount ? `, ${log.issueCount} parse issue(s)` : ''}. Starting analysis…`);
      if (log.issueCount) {
        await alert({ tone: 'warning', title: 'Some lines could not be parsed', message: `${log.issueCount} incomplete or invalid JSON object(s) were found.`, hint: 'Complete entries are still analysed; broken objects are skipped or kept as text.' });
      }
      setFile(null);
      if (input.current) input.current.value = '';
      onUploaded?.(log);
    } catch (err) {
      showError(err, 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Upload a log file</h2>
      <p className="muted small">The analysis starts automatically after upload and opens its live progress.</p>
      <label
        className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]); }}
      >
        <input ref={input} type="file" accept={accept} disabled={busy} onChange={(e) => choose(e.target.files[0])} />
        <span className="dropzone-icon" aria-hidden>⇪</span>
        {file ? (
          <span><strong>{file.name}</strong> · {formatBytes(file.size)}</span>
        ) : (
          <span><strong>Drop a log here</strong> or click to browse</span>
        )}
        {limits && <span className="muted small">{limits.allowedExtensions.join(', ')} · up to {formatBytes(limits.maxUploadBytes)}</span>}
      </label>
      <div className="row end">
        {file && !busy && <button className="secondary" onClick={() => { setFile(null); if (input.current) input.current.value = ''; }}>Clear</button>}
        <button onClick={upload} disabled={!file || busy}>{busy ? <Spinner label="Uploading & parsing…" /> : 'Upload & analyse'}</button>
      </div>
    </section>
  );
}
