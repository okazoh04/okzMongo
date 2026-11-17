import { useState } from "react";
import { useI18n } from "../i18n";
import { exprErrorMessage, formatMongoExpr, parseMongoExpr } from "../lib/mongoExpr";
import { useContentAssist } from "../lib/useContentAssist";

interface Props {
  title: string;
  value: unknown;
  onSave: (parsed: unknown) => void;
  onClose: () => void;
}

export default function JsonEditDialog({ title, value, onSave, onClose }: Props) {
  const { t } = useI18n();
  const [json, setJson] = useState(formatMongoExpr(value));
  const [error, setError] = useState<string | null>(null);
  // 接続・コレクションの文脈が無いので、演算子とヘルパー（ObjectId 等）のみ補完する
  const assist = useContentAssist({ mode: "expr", setValue: setJson });

  const handleOk = () => {
    let parsed: unknown;
    try {
      parsed = parseMongoExpr(json);
    } catch (e) {
      setError(`${t.invalidJson}: ${exprErrorMessage(e, t)}`);
      return;
    }
    onSave(parsed);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 300,
      }}
    >
      <div
        style={{
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          width: 560,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            fontWeight: 600,
            color: "var(--accent)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{title}</span>
          <button onClick={onClose} style={{ background: "none", fontSize: 16 }}>✕</button>
        </div>

        {error && (
          <div style={{ background: "var(--red)", color: "var(--bg3)", padding: "6px 16px", fontSize: 12 }}>
            {error}
          </div>
        )}

        <textarea
          ref={assist.ref as React.RefObject<HTMLTextAreaElement>}
          value={json}
          onChange={assist.onInput}
          onBlur={assist.onBlur}
          onKeyDown={(e) => {
            if (assist.onKeyDown(e)) return;
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleOk();
            }
          }}
          style={{
            flex: 1,
            resize: "none",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 12,
            padding: 16,
            background: "var(--bg3)",
            border: "none",
            color: "var(--text)",
            minHeight: 240,
          }}
          spellCheck={false}
        />
        {assist.dropdown}

        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" onClick={handleOk}>{t.ok}</button>
        </div>
      </div>
    </div>
  );
}
