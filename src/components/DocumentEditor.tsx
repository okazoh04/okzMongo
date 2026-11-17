import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import DocumentTree from "./tree/DocumentTree";
import { unwrapValue } from "../lib/bsonTypes";
import { usePolicy } from "../PolicyProvider";
import { EnvironmentTier } from "../types";
import { exprErrorMessage, formatMongoExpr, parseMongoExpr } from "../lib/mongoExpr";
import { useContentAssist } from "../lib/useContentAssist";

interface Props {
  connectionId: string;
  db: string;
  collection: string;
  environment: EnvironmentTier;
  initialDoc: Record<string, unknown>;
  isNew?: boolean;
  onSaved: () => void;
  onClose: () => void;
}

type Tab = "tree" | "json";

// ドキュメントはオブジェクトでなければならない
function parseDoc(src: string, notObjectMsg: string): Record<string, unknown> {
  const v = parseMongoExpr(src);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(notObjectMsg);
  }
  return v as Record<string, unknown>;
}

export default function DocumentEditor({
  connectionId,
  db,
  collection,
  environment,
  initialDoc,
  isNew = false,
  onSaved,
  onClose,
}: Props) {
  const { t } = useI18n();
  const { guard } = usePolicy();
  const [tab, setTab] = useState<Tab>("tree");
  const [draftDoc, setDraftDoc] = useState<Record<string, unknown>>(initialDoc);
  const [json, setJson] = useState(formatMongoExpr(initialDoc));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const assist = useContentAssist({ mode: "expr", connectionId, db, collection, setValue: setJson });

  const switchTab = (next: Tab) => {
    if (next === "json" && tab === "tree") {
      setJson(formatMongoExpr(draftDoc));
    }
    if (next === "tree" && tab === "json") {
      try {
        setDraftDoc(parseDoc(json, t.docMustBeObject));
      } catch (e) {
        setError(`${t.invalidJson}: ${exprErrorMessage(e, t)}`);
        return;
      }
    }
    setError(null);
    setTab(next);
  };

  const handleSave = async () => {
    let parsed: Record<string, unknown>;
    if (tab === "json") {
      try {
        parsed = parseDoc(json, t.docMustBeObject);
      } catch (e) {
        setError(`${t.invalidJson}: ${exprErrorMessage(e, t)}`);
        return;
      }
    } else {
      parsed = draftDoc;
    }

    if (!await guard(environment, isNew ? "insertDoc" : "updateDoc")) return;

    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await invoke("insert_document", {
          connectionId,
          dbName: db,
          collectionName: collection,
          docJson: JSON.stringify(parsed),
        });
      } else {
        const id = unwrapValue(initialDoc._id) as string;
        await invoke("update_document", {
          connectionId,
          dbName: db,
          collectionName: collection,
          id,
          docJson: JSON.stringify(parsed),
        });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    background: active ? "var(--surface)" : "none",
    borderRadius: 0,
    fontSize: 13,
    padding: "9px 0",
  });

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.6)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100,
    }}>
      <div style={{
        background: "var(--bg2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        width: 600,
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          fontWeight: 600,
          color: "var(--accent)",
          display: "flex",
          justifyContent: "space-between",
        }}>
          <span>{isNew ? t.addDocTitle : t.editDocTitle}</span>
          <button onClick={onClose} style={{ background: "none", fontSize: 16 }}>✕</button>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          <button onClick={() => switchTab("tree")} style={tabButtonStyle(tab === "tree")}>{t.treeTab}</button>
          <button onClick={() => switchTab("json")} style={tabButtonStyle(tab === "json")}>{t.jsonTab}</button>
        </div>

        {error && (
          <div style={{
            background: "var(--red)",
            color: "var(--bg3)",
            padding: "6px 16px",
            fontSize: 12,
          }}>
            {error}
          </div>
        )}

        {tab === "tree" ? (
          <div style={{ flex: 1, overflow: "auto", padding: 12, minHeight: 300 }}>
            <DocumentTree value={draftDoc} onChange={setDraftDoc} onSave={handleSave} />
          </div>
        ) : (
          <>
          <textarea
            ref={assist.ref as React.RefObject<HTMLTextAreaElement>}
            value={json}
            onChange={assist.onInput}
            onBlur={assist.onBlur}
            onKeyDown={(e) => {
              if (assist.onKeyDown(e)) return;
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSave();
              }
            }}
            style={{
              flex: 1,
              resize: "none",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 13,
              padding: 16,
              background: "var(--bg3)",
              border: "none",
              color: "var(--text)",
              minHeight: 300,
            }}
            spellCheck={false}
          />
          {assist.dropdown}
          </>
        )}

        <div style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
        }}>
          <button onClick={onClose}>{t.cancel}</button>
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? t.saving : t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
