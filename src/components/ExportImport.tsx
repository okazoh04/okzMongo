import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n";

interface Props {
  db: string;
  collection: string;
}

export default function ExportImport({ db, collection }: Props) {
  const { t, tpl } = useI18n();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const handleExport = async () => {
    setWorking(true);
    setStatus(null);
    setError(null);
    try {
      const path = await save({
        defaultPath: `${collection}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (path) {
        // Rust 側がファイルへ直接ストリーム書き出しする（全件を文字列で受け取らない）
        const count: number = await invoke("export_collection", {
          dbName: db,
          collectionName: collection,
          filePath: path,
        });
        setStatus(tpl(t.transferExportDone, { path, count: count.toLocaleString() }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const handleImport = async () => {
    setWorking(true);
    setStatus(null);
    setError(null);
    try {
      const path = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });

      if (!path) return;

      const count: number = await invoke("import_collection", {
        dbName: db,
        collectionName: collection,
        filePath: path as string,
      });
      setStatus(tpl(t.transferImportDone, { count: count.toLocaleString() }));
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div style={{
      padding: "8px 12px",
      borderTop: "1px solid var(--border)",
      background: "var(--bg2)",
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{ color: "var(--text-sub)", fontSize: 11, whiteSpace: "nowrap" }}>{t.transferLabel}</span>
      <button onClick={handleExport} disabled={working} style={{ fontSize: 11, whiteSpace: "nowrap" }}>
        {t.transferExport}
      </button>
      <button onClick={handleImport} disabled={working} style={{ fontSize: 11, whiteSpace: "nowrap" }}>
        {t.transferImport}
      </button>
      {status && <span style={{ color: "var(--green)", fontSize: 11, minWidth: 0, overflowWrap: "anywhere" }}>{status}</span>}
      {error && <span style={{ color: "var(--red)", fontSize: 11, minWidth: 0, overflowWrap: "anywhere" }}>{error}</span>}
    </div>
  );
}
