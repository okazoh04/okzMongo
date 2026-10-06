import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open, confirm } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import DocumentEditor from "./DocumentEditor";
import DocumentTree from "./tree/DocumentTree";
import { useI18n } from "../i18n";
import { unwrapValue } from "../lib/bsonTypes";
import { usePolicy } from "../PolicyProvider";
import { EnvironmentTier } from "../types";
import { useClipboard, clipLabel } from "../ClipboardProvider";

interface Props {
  connectionId: string;
  db: string;
  collection: string;
  filterJson: string;
  environment: EnvironmentTier;
}

const PAGE_SIZE = 50;

export default function DocumentList({ connectionId, db, collection, filterJson, environment }: Props) {
  const { t, tpl } = useI18n();
  const { guard } = usePolicy();
  const { clip, copy, paste } = useClipboard();
  const [docs, setDocs] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [ioStatus, setIoStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<number>>(new Set());
  // 選択中ドキュメントの _id（Extended JSON 文字列）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fetched, cnt] = await Promise.all([
        invoke<Record<string, unknown>[]>("find_documents", {
          connectionId,
          dbName: db,
          collectionName: collection,
          filterJson,
          skip: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
        invoke<number>("count_documents", {
          connectionId,
          dbName: db,
          collectionName: collection,
          filterJson,
        }),
      ]);
      setDocs(fetched);
      setTotal(cnt);
      setDirtyKeys(new Set());
      setSelectedIds(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, db, collection, filterJson, page]);

  useEffect(() => {
    setPage(0);
  }, [connectionId, db, collection, filterJson]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (id: string) => {
    if (!await guard(environment, "deleteDoc")) return;
    if (!await confirm(t.deleteDocConfirm)) return;
    try {
      await invoke("delete_document", { connectionId, dbName: db, collectionName: collection, id });
      load();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDocChange = (index: number, next: Record<string, unknown>) => {
    setDocs((prev) => {
      const copy = [...prev];
      copy[index] = next;
      return copy;
    });
    setDirtyKeys((prev) => new Set(prev).add(index));
  };

  const handleSaveRow = async (index: number) => {
    const doc = docs[index];
    const id = unwrapValue(doc._id) as string | undefined;
    if (!id) return;
    if (!await guard(environment, "updateDoc")) return;
    try {
      await invoke("update_document", {
        connectionId,
        dbName: db,
        collectionName: collection,
        id,
        docJson: JSON.stringify(doc),
      });
      setDirtyKeys((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    } catch (e) {
      alert(String(e));
    }
  };

  const handleExport = async () => {
    setIoStatus(null);
    try {
      const json: string = await invoke("export_collection", {
        connectionId,
        dbName: db,
        collectionName: collection,
      });
      const path = await save({
        defaultPath: `${collection}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await writeTextFile(path, json);
        setIoStatus({ msg: tpl(t.exportSuccess, { path }), ok: true });
      }
    } catch (e) {
      setIoStatus({ msg: String(e), ok: false });
    }
  };

  const handleImport = async () => {
    setIoStatus(null);
    if (!await guard(environment, "importCollection")) return;
    try {
      const path = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return;
      const jsonData = await readTextFile(path as string);
      const count: number = await invoke("import_collection", {
        connectionId,
        dbName: db,
        collectionName: collection,
        jsonData,
      });
      setIoStatus({ msg: tpl(t.importSuccess, { count: count.toLocaleString() }), ok: true });
      load();
    } catch (e) {
      setIoStatus({ msg: String(e), ok: false });
    }
  };

  const idKey = (doc: Record<string, unknown>) => JSON.stringify(doc._id);

  const toggleSelected = (key: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  /** 選択があれば選択分、無ければ現在の絞り込み条件に一致する全件をコピーする */
  const handleCopy = () => {
    const base = { kind: "documents" as const, connectionId, db, collection };
    if (selectedIds.size > 0) {
      const ids = [...selectedIds].map(k => JSON.parse(k));
      copy({ ...base, filterJson: JSON.stringify({ _id: { $in: ids } }), count: ids.length });
    } else {
      copy({ ...base, filterJson, count: total });
    }
  };

  const handlePaste = async () => {
    if (await paste({ connectionId, db, collection, environment })) load();
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* ツールバー */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg2)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}>
        <span style={{ color: "var(--text-sub)", fontSize: 12, minWidth: 60 }}>
          {loading ? t.loading : tpl(t.docCount, { count: total.toLocaleString() })}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowNew(true)} className="primary">{t.addDoc}</button>
        <button onClick={load}>{t.refresh}</button>
        <span style={{ color: "var(--border)" }}>|</span>
        <button onClick={handleCopy} disabled={total === 0}>
          {selectedIds.size > 0 ? tpl(t.copySelected, { count: selectedIds.size }) : t.copyAll}
        </button>
        <button
          onClick={handlePaste}
          disabled={!clip}
          title={clip ? tpl(t.pasteFromTitle, { src: clipLabel(clip) }) : t.clipboardEmpty}
        >{t.paste}</button>
        <span style={{ color: "var(--border)" }}>|</span>
        <button onClick={handleExport}>{t.exportBtn}</button>
        <button onClick={handleImport}>{t.importBtn}</button>
      </div>

      {/* エラー / IO状態 */}
      {error && (
        <div style={{ background: "var(--red)", color: "var(--bg3)", padding: "5px 12px", fontSize: 12, flexShrink: 0 }}>
          {error}
        </div>
      )}
      {ioStatus && (
        <div style={{
          background: ioStatus.ok ? "var(--green)" : "var(--red)",
          color: "var(--bg3)",
          padding: "5px 12px",
          fontSize: 12,
          flexShrink: 0,
          display: "flex",
          justifyContent: "space-between",
        }}>
          <span>{ioStatus.msg}</span>
          <button onClick={() => setIoStatus(null)} style={{ background: "none", fontSize: 11, color: "var(--bg3)" }}>✕</button>
        </div>
      )}

      {/* ドキュメント一覧 */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {docs.map((doc, i) => {
          const id = unwrapValue(doc._id) as string | undefined;
          const dirty = dirtyKeys.has(i);
          return (
            <div
              key={id ?? i}
              style={{
                borderBottom: "1px solid var(--border)",
                padding: "8px 12px",
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
              }}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(idKey(doc))}
                onChange={() => toggleSelected(idKey(doc))}
                title={t.selectForCopy}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                {dirty && (
                  <div style={{ fontSize: 10, color: "var(--yellow)", marginBottom: 3 }}>
                    {t.unsavedHint}
                  </div>
                )}
                <DocumentTree
                  value={doc}
                  onChange={(next) => handleDocChange(i, next)}
                  onSave={() => handleSaveRow(i)}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                {id && (
                  <button
                    onClick={() => handleDelete(id)}
                    style={{ fontSize: 12, padding: "5px 10px", color: "var(--red)" }}
                  >
                    {t.deleteDoc}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {docs.length === 0 && !loading && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
            {t.noDocuments}
          </div>
        )}
      </div>

      {/* ページネーション */}
      {totalPages > 1 && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderTop: "1px solid var(--border)",
          background: "var(--bg2)",
          flexShrink: 0,
        }}>
          <button onClick={() => setPage(0)} disabled={page === 0}>|◀️</button>
          <button onClick={() => setPage((p) => p - 1)} disabled={page === 0}>◀️</button>
          <span style={{ fontSize: 12, color: "var(--text-sub)" }}>
            {page + 1} / {totalPages}
          </span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1}>▶️</button>
          <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>▶️|</button>
        </div>
      )}

      {showNew && (
        <DocumentEditor
          connectionId={connectionId}
          db={db}
          collection={collection}
          environment={environment}
          initialDoc={{}}
          isNew
          onSaved={() => { setShowNew(false); load(); }}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}
