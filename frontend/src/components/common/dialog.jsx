// App-wide dialogs (native <dialog>: focus trap, Esc to close) and toasts.
//   const { alert, confirm, showError, toast } = useDialog();
//   await alert({ title, message, tone });           -> resolves when closed
//   if (await confirm({ title, message })) { ... }   -> true / false
//   showError(apiError)                              -> friendly error dialog
//   toast('Uploaded')                                -> short success notice
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { describeError } from '../../services/errors.js';

const DialogContext = createContext(null);
const TOAST_MS = Number(import.meta.env.VITE_TOAST_MS) || 3500;
const ICONS = { error: '!', warning: '!', info: 'i', success: '✓', danger: '!' };

export function DialogProvider({ children }) {
  const [current, setCurrent] = useState(null); // { title, message, hint, tone, confirmLabel, cancelLabel, resolve }
  const [toasts, setToasts] = useState([]);
  const ref = useRef(null);
  const queue = useRef([]);

  // One dialog at a time; later requests wait in a queue.
  const open = useCallback((options) => new Promise((resolve) => {
    const item = { ...options, resolve };
    setCurrent((cur) => {
      if (cur) {
        queue.current.push(item);
        return cur;
      }
      return item;
    });
  }), []);

  const close = (value) => {
    current?.resolve(value);
    setCurrent(queue.current.shift() || null);
  };

  useEffect(() => {
    const el = ref.current;
    if (current && el && !el.open) el.showModal();
    if (!current && el?.open) el.close();
  }, [current]);

  const api = {
    alert: useCallback((o) => open({ tone: 'info', confirmLabel: 'OK', ...o }), [open]),
    confirm: useCallback((o) => open({ tone: 'warning', confirmLabel: 'Confirm', cancelLabel: 'Cancel', ...o }), [open]),
    showError: useCallback((err, title) => {
      const d = describeError(err);
      return open({ ...d, title: title || d.title, confirmLabel: 'OK' });
    }, [open]),
    toast: useCallback((message, tone = 'success') => {
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((t) => [...t, { id, message, tone }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
    }, []),
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      <dialog ref={ref} className={`dialog tone-${current?.tone || 'info'}`} onCancel={(e) => { e.preventDefault(); close(false); }}>
        {current && (
          <form method="dialog" onSubmit={(e) => { e.preventDefault(); close(true); }}>
            <div className="dialog-head">
              <span className="dialog-icon" aria-hidden>{ICONS[current.tone] || 'i'}</span>
              <h3>{current.title}</h3>
            </div>
            {current.message && <p className="dialog-message">{current.message}</p>}
            {current.hint && <p className="dialog-hint">{current.hint}</p>}
            <div className="dialog-actions">
              {current.cancelLabel && <button type="button" className="secondary" onClick={() => close(false)}>{current.cancelLabel}</button>}
              <button type="submit" className={current.tone === 'danger' ? 'danger' : ''} autoFocus>{current.confirmLabel}</button>
            </div>
          </form>
        )}
      </dialog>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast tone-${t.tone}`}>{t.message}</div>)}
      </div>
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>');
  return ctx;
}
