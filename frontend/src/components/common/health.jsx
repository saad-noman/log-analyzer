// Shared system health (one poll for the whole app): database, local model,
// measured memory and upload limits. Used by the header, the dashboard status
// card, the upload pre-check and the "start analysis" guard.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../../services/api.js';
import { useInterval } from './ui.jsx';

const HealthContext = createContext({ health: null, refresh: () => {} });
const HEALTH_INTERVAL_MS = Number(import.meta.env.VITE_HEALTH_INTERVAL_MS) || 15000;

export function HealthProvider({ children }) {
  const [health, setHealth] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth({ ...h, reachable: true });
      return h;
    } catch (err) {
      // 503 still carries a body; network errors mean the API itself is down.
      const h = err.status === 503 && err.body ? { ...err.body, reachable: true } : null;
      const value = h || { ok: false, reachable: err.code !== 'NETWORK_ERROR', database: false, model: { ok: false, error: err.message } };
      setHealth(value);
      return value;
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useInterval(refresh, HEALTH_INTERVAL_MS);
  return <HealthContext.Provider value={{ health, refresh }}>{children}</HealthContext.Provider>;
}

export const useHealth = () => useContext(HealthContext);
