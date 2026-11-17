import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";

interface Props {
  db: string;
  collection: string;
}

export default function ExportImport({ db, collection }: Props) {
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
        setStatus(`エクスポート完了: ${path}（${count.toLocaleString()} 件）`);
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
      setStatus(`インポート完了: ${count.toLocaleString()} 件追加`);
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
      alignItems: "center",
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{ color: "var(--text-sub)", fontSize: 11 }}>バックアップ / 移行:</span>
      <button onClick={handleExport} disabled={working} style={{ fontSize: 11 }}>
        エクスポート
      </button>
      <button onClick={handleImport} disabled={working} style={{ fontSize: 11 }}>
        インポート
      </button>
      {status && <span style={{ color: "var(--green)", fontSize: 11 }}>{status}</span>}
      {error && <span style={{ color: "var(--red)", fontSize: 11 }}>{error}</span>}
    </div>
  );
}
