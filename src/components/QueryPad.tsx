import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n, tpl, type Messages } from "../i18n";
import DocumentTree from "./tree/DocumentTree";
import { usePolicy } from "../PolicyProvider";
import { EnvironmentTier } from "../types";
import { exprErrorMessage, mongoExprToJson } from "../lib/mongoExpr";
import { useContentAssist } from "../lib/useContentAssist";

interface Props {
  connectionId: string;
  db: string;
  initialQuery?: string;
  environment: EnvironmentTier;
}

const PAGE_SIZE = 50;

const METHODS = [
  "find", "findOne", "aggregate", "countDocuments",
  "insertOne", "updateOne", "deleteOne",
  "drop", "createIndex", "dropIndex", "estimatedDocumentCount",
];

// ネストを考慮してトップレベルのカンマで引数を分割
function splitArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let strCh = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === strCh && s[i - 1] !== "\\") inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true; strCh = ch; cur += ch;
    } else if ("{[(".includes(ch)) {
      depth++; cur += ch;
    } else if ("}])".includes(ch)) {
      depth--; cur += ch;
    } else if (ch === "," && depth === 0) {
      args.push(cur.trim()); cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

interface Parsed {
  collection: string;
  method: string;
  args: string[];
}

// 引数文字列を Extended JSON 文字列に変換する。空なら fallback をそのまま返す。
function argToJson(argStr: string | undefined, fallback: string, t: Messages): string {
  try {
    return mongoExprToJson(argStr ?? "", fallback);
  } catch (e) {
    throw new Error(tpl(t.exprEvalFailed, { error: exprErrorMessage(e, t) }));
  }
}

function parseMongosh(input: string, formatHint: string): Parsed | string {
  const s = input.trim().replace(/;?\s*$/, "");
  const m = s.match(/^db\.(\w+)\.(\w+)\(([\s\S]*)\)$/);
  if (!m) return formatHint;
  return { collection: m[1], method: m[2], args: splitArgs(m[3].trim()) };
}

type ResultView =
  | { kind: "docs"; docs: Record<string, unknown>[]; total: number; page: number; isAggregate: boolean }
  | { kind: "scalar"; label: string; value: unknown }
  | { kind: "message"; ok: boolean; text: string };

export default function QueryPad({ connectionId, db, initialQuery, environment }: Props) {
  const { t } = useI18n();
  const { guard } = usePolicy();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [result, setResult] = useState<ResultView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // コンテンツアシスト（コレクション名・メソッド・演算子・フィールド名・ヘルパー）
  const assist = useContentAssist({ mode: "query", connectionId, db, setValue: setQuery });

  // initialQuery が変わったら反映
  useEffect(() => {
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialQuery]);

  const runQuery = useCallback(async (targetPage = 0) => {
    const q = query.trim();
    if (!q) return;

    const parsed = parseMongosh(q, t.queryFormatHint);
    if (typeof parsed === "string") { setError(parsed); return; }

    const { collection: col, method, args } = parsed;
    if (["insertOne", "updateOne", "deleteOne"].includes(method)) {
      if (!await guard(environment, "queryWrite")) return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      switch (method) {
        case "find": {
          const filterJson = argToJson(args[0], "{}", t);
          const skip = targetPage * PAGE_SIZE;
          const [docs, total] = await Promise.all([
            invoke<Record<string, unknown>[]>("find_documents", {
              connectionId, dbName: db, collectionName: col,
              filterJson, skip, limit: PAGE_SIZE,
            }),
            invoke<number>("count_documents", {
              connectionId, dbName: db, collectionName: col, filterJson,
            }),
          ]);
          setResult({ kind: "docs", docs, total, page: targetPage, isAggregate: false });
          break;
        }
        case "findOne": {
          const filterJson = argToJson(args[0], "{}", t);
          const docs = await invoke<Record<string, unknown>[]>("find_documents", {
            connectionId, dbName: db, collectionName: col,
            filterJson, skip: 0, limit: 1,
          });
          setResult({ kind: "docs", docs, total: docs.length, page: 0, isAggregate: false });
          break;
        }
        case "aggregate": {
          const pipelineJson = argToJson(args[0], "[]", t);
          const docs = await invoke<Record<string, unknown>[]>("run_aggregate", {
            connectionId, dbName: db, collectionName: col, pipelineJson,
          });
          setResult({ kind: "docs", docs, total: docs.length, page: 0, isAggregate: true });
          break;
        }
        case "countDocuments":
        case "estimatedDocumentCount": {
          const filterJson = method === "estimatedDocumentCount" ? "{}" : argToJson(args[0], "{}", t);
          const cnt = await invoke<number>("count_documents", {
            connectionId, dbName: db, collectionName: col, filterJson,
          });
          setResult({ kind: "scalar", label: method, value: cnt });
          break;
        }
        case "insertOne": {
          const docJson = argToJson(args[0], "{}", t);
          const id = await invoke<string>("insert_document", {
            connectionId, dbName: db, collectionName: col, docJson,
          });
          setResult({ kind: "message", ok: true, text: tpl(t.queryInsertDone, { id }) });
          break;
        }
        case "updateOne": {
          const filterJson = argToJson(args[0], "{}", t);
          const updateJson = argToJson(args[1], "{}", t);
          const cnt = await invoke<number>("update_one_by_filter", {
            connectionId, dbName: db, collectionName: col, filterJson, updateJson,
          });
          setResult({ kind: "message", ok: true, text: tpl(t.queryUpdateDone, { count: cnt }) });
          break;
        }
        case "deleteOne": {
          const filterJson = argToJson(args[0], "{}", t);
          const cnt = await invoke<number>("delete_one_by_filter", {
            connectionId, dbName: db, collectionName: col, filterJson,
          });
          setResult({ kind: "message", ok: cnt > 0, text: tpl(t.queryDeleteDone, { count: cnt }) });
          break;
        }
        default:
          setError(tpl(t.queryUnsupportedMethod, { method, methods: METHODS.slice(0, 7).join(", ") }));
      }
    } catch (e) {
      setError(tpl(t.queryError, { error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [connectionId, db, query, t, environment, guard]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (assist.onKeyDown(e)) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(0); }
  };

  const totalPages = result?.kind === "docs" && !result.isAggregate
    ? Math.ceil(result.total / PAGE_SIZE) : 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* 入力エリア */}
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid var(--border)",
        background: "var(--bg2)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 6,
      }}>
        <div style={{ fontSize: 11, color: "var(--yellow)" }}>{db}</div>

        <div>
          <textarea
            ref={assist.ref as React.RefObject<HTMLTextAreaElement>}
            value={query}
            onChange={assist.onInput}
            onKeyDown={handleKeyDown}
            onBlur={assist.onBlur}
            placeholder={`db.collection.find({field: "value"})\ndb.collection.aggregate([{$match: {...}}])\ndb.collection.countDocuments({})\ndb.collection.insertOne({...})\ndb.collection.updateOne({filter}, {update})\ndb.collection.deleteOne({filter})`}
            rows={5}
            style={{
              width: "100%", fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 13, resize: "vertical", background: "var(--bg)",
              color: "var(--text)", border: "1px solid var(--border)",
              borderRadius: 4, padding: "6px 8px", boxSizing: "border-box",
            }}
          />
          {assist.dropdown}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="primary" onClick={() => runQuery(0)} disabled={loading}>
            {loading ? "…" : t.runQuery}
          </button>
          <button onClick={() => { setQuery(""); setResult(null); setError(null); assist.onBlur(); }}>
            {t.clear}
          </button>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Ctrl+Enter {t.runQuery}</span>
        </div>
      </div>

      {/* エラー */}
      {error && (
        <div style={{ background: "var(--red)", color: "var(--bg3)", padding: "5px 12px", fontSize: 12, flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* 結果 */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {result?.kind === "scalar" && (
          <div style={{ padding: "16px 12px", fontSize: 13 }}>
            <span style={{ color: "var(--text-muted)", marginRight: 8 }}>{result.label}:</span>
            <span style={{ color: "var(--accent2)", fontFamily: "monospace", fontWeight: 700 }}>
              {String(result.value)}
            </span>
          </div>
        )}

        {result?.kind === "message" && (
          <div style={{
            padding: "8px 12px", fontSize: 12, flexShrink: 0,
            background: result.ok ? "var(--green)" : "var(--red)", color: "var(--bg3)",
          }}>
            {result.text}
          </div>
        )}

        {result?.kind === "docs" && (
          <>
            <div style={{
              padding: "5px 12px", borderBottom: "1px solid var(--border)",
              background: "var(--bg2)", fontSize: 12, color: "var(--text-sub)", flexShrink: 0,
            }}>
              {tpl(t.queryResultCount, { count: result.total.toLocaleString() })}
              {result.isAggregate && <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.7 }}>aggregate</span>}
            </div>
            {result.docs.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>{t.queryNoResult}</div>
            )}
            {result.docs.map((doc, i) => (
              <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "8px 12px" }}>
                <DocumentTree value={doc} readOnly />
              </div>
            ))}
          </>
        )}
      </div>

      {/* ページネーション（find のみ） */}
      {result?.kind === "docs" && !result.isAggregate && totalPages > 1 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
          borderTop: "1px solid var(--border)", background: "var(--bg2)", flexShrink: 0,
        }}>
          <button onClick={() => runQuery(0)} disabled={result.page === 0}>|◀️</button>
          <button onClick={() => runQuery(result.page - 1)} disabled={result.page === 0}>◀️</button>
          <span style={{ fontSize: 12, color: "var(--text-sub)" }}>{result.page + 1} / {totalPages}</span>
          <button onClick={() => runQuery(result.page + 1)} disabled={result.page >= totalPages - 1}>▶️</button>
          <button onClick={() => runQuery(totalPages - 1)} disabled={result.page >= totalPages - 1}>▶️|</button>
        </div>
      )}
    </div>
  );
}
