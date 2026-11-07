// Single API client. All data shown in the UI comes from these backend calls.
// The Vite dev server proxies /api to the backend (vite.config.js).
const BASE = import.meta.env.VITE_API_BASE || '/api';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, headers } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      headers: body instanceof FormData || body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the backend. Is the API server running?');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error || {};
    const error = new ApiError(res.status, e.code || `HTTP_${res.status}`, e.message || res.statusText, e.details);
    error.body = data; // e.g. /health returns its full status with 503
    throw error;
  }
  return data;
}

export const api = {
  health: () => request('/health'),

  uploadLog: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/logs/upload', { method: 'POST', body: form });
  },
  listLogs: () => request('/logs'),
  deleteLog: (id) => request(`/logs/${id}`, { method: 'DELETE' }),

  startAnalysis: (logId) => request('/analyses', { method: 'POST', body: { logId } }),
  listAnalyses: (logId) => request(`/analyses${logId ? `?logId=${logId}` : ''}`),
  getAnalysis: (id) => request(`/analyses/${id}`),
  retryAnalysis: (id) => request(`/analyses/${id}/retry`, { method: 'POST' }),
  cancelAnalysis: (id) => request(`/analyses/${id}/cancel`, { method: 'POST' }),
  deleteAnalysis: (id) => request(`/analyses/${id}`, { method: 'DELETE' }),

  getReport: (id) => request(`/reports/${id}`),
  reportDownloadUrl: (id) => `${BASE}/reports/${id}/download`,
};

export const ACTIVE_STATUSES = ['queued', 'running'];
export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 3000;
