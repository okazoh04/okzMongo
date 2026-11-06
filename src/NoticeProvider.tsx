import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";
import { useI18n } from "./i18n";

interface NoticeContextValue {
  /** アプリ内の中央モーダルで通知を表示し、閉じられたら解決する（alert の代替） */
  notify: (message: string) => Promise<void>;
}

const NoticeContext = createContext<NoticeContextValue | null>(null);

export function NoticeProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useRef<(() => void) | null>(null);

  const notify = useCallback((msg: string) => {
    return new Promise<void>(resolve => {
      resolver.current = resolve;
      setMessage(msg);
    });
  }, []);

  const close = () => {
    const r = resolver.current;
    resolver.current = null;
    setMessage(null);
    r?.();
  };

  return (
    <NoticeContext.Provider value={{ notify }}>
      {children}
      {message !== null && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 2000,
            background: "rgba(0,0,0,0.55)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={e => { if (e.target === e.currentTarget) close(); }}
          onKeyDown={e => { if (e.key === "Escape" || e.key === "Enter") close(); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "16px 18px", minWidth: 320, maxWidth: 560, maxHeight: "70vh",
              display: "flex", flexDirection: "column", gap: 12,
            }}
          >
            <div style={{ whiteSpace: "pre-wrap", overflowY: "auto", fontSize: 13, color: "var(--text)" }}>
              {message}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="primary" autoFocus onClick={close} style={{ fontSize: 12, padding: "5px 16px" }}>
                {t.ok}
              </button>
            </div>
          </div>
        </div>
      )}
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeContextValue {
  const ctx = useContext(NoticeContext);
  if (!ctx) throw new Error("useNotice は NoticeProvider 内で使用してください");
  return ctx;
}
