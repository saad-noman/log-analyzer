import { useNavigate } from 'react-router-dom';
import UploadPanel from '../components/logs/UploadPanel.jsx';
import SystemStatus from '../components/dashboard/SystemStatus.jsx';
import Reports from './Reports.jsx';
import { api } from '../services/api.js';
import { useDialog } from '../components/common/dialog.jsx';
import { useHealth } from '../components/common/health.jsx';

// Upload (analysis starts automatically) + system status + saved analyses.
export default function Dashboard() {
  const navigate = useNavigate();
  const { showError, alert } = useDialog();
  const { refresh: refreshHealth } = useHealth();

  async function start(log) {
    // Guard: check the model right now instead of waiting for a failed request.
    const health = await refreshHealth();
    if (!health?.model?.ok) {
      await alert({ tone: 'warning', title: 'Local model offline', message: 'The file was uploaded, but the analysis needs the local model.', hint: 'Restart the app with "npm run dev" (it starts the model too), then upload the file again.' });
      return;
    }
    try {
      const analysis = await api.startAnalysis(log._id);
      navigate(`/analyses/${analysis.id}`);
    } catch (err) {
      if (err.code === 'ANALYSIS_IN_PROGRESS' && err.details?.analysisId) navigate(`/analyses/${err.details.analysisId}`);
      else showError(err, 'Could not start the analysis');
    }
  }

  return (
    <div className="page">
      <div className="grid-2">
        {/* A successful upload starts its analysis right away. */}
        <UploadPanel onUploaded={start} />
        <SystemStatus />
      </div>
      {/* Saved analyses and their reports (same component as the Analyses & reports page). */}
      <Reports />
    </div>
  );
}
