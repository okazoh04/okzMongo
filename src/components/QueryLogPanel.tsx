import { useEffect, useRef, useState } from "react";
import { EDGE } from "./TitleBar";
import { useI18n } from "../i18n";

export interface QueryLogEntry {
  ts: number;
  connection_id: string;
  db: string;
  collection: string;
  query: string;
  duration_ms: number;
  ok: boolean;
  detail: string;
}

interface Props {
  entries: QueryLogEntry[];
  connectionName: (id: string) => string;
  onClear: () => void;
  onClose: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export default function QueryLogPanel({ entries, connectionName, onClear, onClose }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // 末尾を見ている間は新着に追従し、遡って読んでいる間は動かさない
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const handleScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div style={{
      height: 200, flexShrink: 0, display: "flex", flexDirection: "column",
      background: "var(--bg2)", borderTop: "1px solid var(--border)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "2px 8px",
        borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-sub)", flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600 }}>{t.queryLog}</span>
        <span style={{ color: "var(--text-muted)" }}>{entries.length}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClear} style={{ fontSize: 11, padding: "1px 8px" }}>{t.clear}</button>
        <button onClick={onClose} style={{ fontSize: 11, padding: "1px 8px" }}>✕</button>
      </div>
      {/* 右端は窓の掴みしろ（EDGE px）。スクロールバーをその内側に収めるため、右を空けておく（地色は同じ bg2 なので継ぎ目は見えない） */}
      <div ref={listRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", fontSize: 12, marginRight: EDGE }}>
        {entries.length === 0 && (
          <div style={{ padding: 12, color: "var(--text-muted)" }}>{t.queryLogEmpty}</div>
        )}
        {entries.map((e, i) => (
          <div
            key={i}
            onClick={() => setExpanded(expanded === i ? null : i)}
            style={{
              display: "flex", gap: 8, padding: "2px 8px", cursor: "pointer", alignItems: "baseline",
              borderBottom: "1px solid var(--surface)",
            }}
          >
            <span style={{ color: "var(--text-muted)", fontFamily: "monospace", flexShrink: 0 }}>{formatTime(e.ts)}</span>
            <span style={{ color: e.ok ? "var(--green)" : "var(--red)", flexShrink: 0 }}>{e.ok ? "●" : "✕"}</span>
            <span style={{ color: "var(--text-muted)", flexShrink: 0, minWidth: 48, textAlign: "right" }}>{e.duration_ms} ms</span>
            <span style={{ color: "var(--accent2)", flexShrink: 0 }}>{connectionName(e.connection_id)}/{e.db}</span>
            <span style={{
              flex: 1, minWidth: 0, fontFamily: "monospace", color: "var(--text)",
              ...(expanded === i
                ? { whiteSpace: "pre-wrap", wordBreak: "break-all" }
                : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
            }}>
              {e.query}
              {expanded === i && (
                <div style={{ color: e.ok ? "var(--text-sub)" : "var(--red)", marginTop: 2 }}>
                  {e.detail}{" "}
                  <button
                    onClick={ev => { ev.stopPropagation(); navigator.clipboard.writeText(e.query); }}
                    style={{ fontSize: 11, padding: "0 6px" }}
                  >{t.queryLogCopy}</button>
                </div>
              )}
            </span>
            {expanded !== i && (
              <span style={{
                color: e.ok ? "var(--text-muted)" : "var(--red)", flexShrink: 0, maxWidth: 220,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }} title={e.detail}>{e.detail}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
