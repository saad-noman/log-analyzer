import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import LogAnalysis from './pages/LogAnalysis.jsx';
import Alerts from './pages/Alerts.jsx';
import Reports from './pages/Reports.jsx';
import { DialogProvider } from './components/common/dialog.jsx';
import { HealthProvider, useHealth } from './components/common/health.jsx';
import { EmptyState, Spinner, useInterval } from './components/common/ui.jsx';
import { api, ACTIVE_STATUSES, POLL_INTERVAL_MS } from './services/api.js';

const IDLE_JOBS_INTERVAL_MS = Number(import.meta.env.VITE_HEALTH_INTERVAL_MS) || 15000;

// Compact readiness indicator in the header (shared health poll).
function HealthIndicator() {
  const { health } = useHealth();
  if (!health) return null;
  const parts = [
    ['API', health.reachable !== false],
    ['DB', Boolean(health.database)],
    ['Model', Boolean(health.model?.ok)],
  ];
  return (
    <div className="health" title={health.model?.error || ''}>
      {parts.map(([label, ok]) => (
        <span key={label} className="health-item"><span className={`dot ${ok ? 'ok' : 'bad'}`} />{label}</span>
      ))}
    </div>
  );
}

// Visible on every page: the running analysis (and how many wait), linking to
// its live progress, so the user can browse freely while it runs.
function ActiveAnalyses() {
  const [jobs, setJobs] = useState([]);
  const refresh = useCallback(() => api.listAnalyses().then((list) => setJobs(list.filter((a) => ACTIVE_STATUSES.includes(a.status)))).catch(() => {}), []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useInterval(refresh, jobs.length ? POLL_INTERVAL_MS : IDLE_JOBS_INTERVAL_MS);
  if (!jobs.length) return null;
  const current = jobs.find((j) => j.status === 'running') || jobs[0];
  const waiting = jobs.length - 1;
  return (
    <Link to={`/analyses/${current.id}`} className="active-jobs" title="Open live progress">
      <Spinner label={`Analysing ${current.completedChunks}/${current.totalChunks}`} />
      {waiting > 0 && <span className="muted">+{waiting} queued</span>}
    </Link>
  );
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const links = [
    ['/', 'Dashboard'],
    ['/alerts', 'Latest findings'],
    ['/reports', 'Analyses & reports'],
  ];
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
        <div className="brand">
          <span className="logo" aria-hidden>◈</span>
          <span>Local AI Security Log Analyzer</span>
        </div>
        <button className="menu-toggle secondary" aria-label="Toggle navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>☰</button>
        <nav className={menuOpen ? 'open' : ''} onClick={() => setMenuOpen(false)}>
          {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
        </nav>
        <ActiveAnalyses />
        <HealthIndicator />
        </div>
      </header>
      <div className="app">
      <main key={location.pathname}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/analyses/:id" element={<LogAnalysis />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="*" element={<EmptyState icon="?" title="Page not found" />} />
        </Routes>
      </main>
      <footer className="muted small">Runs fully offline · local llama.cpp model · log content is treated as untrusted data</footer>
      </div>
    </>
  );
}

export default function App() {
  return (
    <DialogProvider>
      <HealthProvider>
        <Shell />
      </HealthProvider>
    </DialogProvider>
  );
}
