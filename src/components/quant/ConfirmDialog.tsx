import { useEffect, useState } from "react";

/**
 * Themed replacement for window.confirm(). Call `confirmDialog(...)` anywhere;
 * `<ConfirmHost />` (mounted once in App) renders it in the app's dark theme.
 */

interface Req { title: string; message: string; okLabel: string; danger: boolean; resolve: (ok: boolean) => void }
let listener: ((r: Req | null) => void) | null = null;

export function confirmDialog(message: string, opts: { title?: string; okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) { resolve(window.confirm(message)); return; } // host not mounted (tests, proof page)
    listener({ title: opts.title ?? "Confirm", message, okLabel: opts.okLabel ?? "Confirm", danger: opts.danger ?? false, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => { listener = setReq; return () => { listener = null; }; }, []);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  if (!req) return null;
  const done = (ok: boolean) => { req.resolve(ok); setReq(null); };
  return (
    <div className="modal-overlay" onClick={() => done(false)} role="dialog" aria-modal="true" aria-label={req.title}>
      <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className={req.danger ? "text-red" : ""}>{req.title}</h3>
        <p className="confirm-msg">{req.message}</p>
        <div className="confirm-actions">
          <button className="btn btn-secondary" onClick={() => done(false)} autoFocus>Cancel</button>
          <button className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} onClick={() => done(true)}>{req.okLabel}</button>
        </div>
      </div>
    </div>
  );
}
