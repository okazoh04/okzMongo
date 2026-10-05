import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save, open, confirm } from "@tauri-apps/plugin-dialog";
import { ConnectionConfig, SelectedItem, defaultConnection, ConnectError, ConnectProgressEvent, ConnectStage, ConnectStageStatus, isConnectError } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { ConnectDiagnostics } from "./ConnectDiagnostics";
import ContextMenu from "./ContextMenu";
import { useI18n } from "../i18n";
import { ENV_LABEL_KEY, ENV_COLOR } from "../policy";
import { usePolicy } from "../PolicyProvider";

interface Props {
  connections: ConnectionConfig[];
  connectedIds: string[];
  selected: SelectedItem | null;
  onSelect: (item: SelectedItem) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onRefresh: () => void;
}

export default function Sidebar({
  connections,
  connectedIds,
  selected,
  onSelect,
  onConnect,
  onDisconnect,
  onRefresh,
}: Props) {
  const { t, tpl } = useI18n();
  const { guard } = usePolicy();
  const [expandedDbs, setExpandedDbs] = useState<Record<string, Set<string>>>({});
  const [collections, setCollections] = useState<Record<string, string[]>>({});
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connError, setConnError] = useState<Record<string, ConnectError>>({});
  const [connProgress, setConnProgress] = useState<Record<string, Partial<Record<ConnectStage, ConnectStageStatus>>>>({});
  const [dropping, setDropping] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<"new" | string | null>(null);
  const [connMenu, setConnMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [newDbInput, setNewDbInput] = useState<Record<string, { dbName: string; colName: string } | null>>({});

  useEffect(() => {
    for (const id of connectedIds) {
      if (!databases[id]) loadDatabases(id);
    }
  }, [connectedIds]);

  const loadDatabases = async (connectionId: string) => {
    try {
      const dbs: string[] = await invoke("list_databases", { connectionId });
      setDatabases(d => ({ ...d, [connectionId]: dbs }));
    } catch (e) {
      console.error(e);
    }
  };

  const toggleDb = async (connectionId: string, db: string) => {
    const key = `${connectionId}::${db}`;
    setExpandedDbs(prev => {
      const next = { ...prev };
      const set = new Set(next[connectionId] ?? []);
      if (set.has(db)) { set.delete(db); } else { set.add(db); }
      next[connectionId] = set;
      return next;
    });
    if (!collections[key]) {
      try {
        const cols: string[] = await invoke("list_collections", { connectionId, dbName: db });
        setCollections(c => ({ ...c, [key]: cols }));
      } catch (e) {
        console.error(e);
      }
    }
  };

  const refreshCollections = async (connectionId: string, db: string) => {
    const key = `${connectionId}::${db}`;
    try {
      const cols: string[] = await invoke("list_collections", { connectionId, dbName: db });
      setCollections(c => ({ ...c, [key]: cols }));
    } catch (e) {
      console.error(e);
    }
  };

  const handleReload = async (connectionId: string) => {
    await loadDatabases(connectionId);
    for (const db of expandedDbs[connectionId] ?? []) {
      await refreshCollections(connectionId, db);
    }
  };

  const handleConnect = async (id: string) => {
    setConnecting(id);
    setConnError(e => { const n = { ...e }; delete n[id]; return n; });
    setConnProgress(p => ({ ...p, [id]: {} }));
    const unlisten = await listen<ConnectProgressEvent>("connect-progress", event => {
      if (event.payload.token !== id) return;
      setConnProgress(prev => ({
        ...prev,
        [id]: { ...prev[id], [event.payload.stage]: event.payload.status },
      }));
    });
    try {
      await invoke("connect", { id });
      onConnect(id);
    } catch (e) {
      setConnError(prev => ({
        ...prev,
        [id]: isConnectError(e) ? e : { stage: "mongo", category: "unknown", detail: String(e) },
      }));
    } finally {
      unlisten();
      setConnecting(null);
    }
  };

  const handleDisconnect = async (id: string) => {
    await invoke("disconnect", { id });
    setDatabases(d => { const n = { ...d }; delete n[id]; return n; });
    setExpandedDbs(d => { const n = { ...d }; delete n[id]; return n; });
    setConnError(e => { const n = { ...e }; delete n[id]; return n; });
    onDisconnect(id);
  };

  const handleSave = async (cfg: Omit<ConnectionConfig, "id"> & { id?: string }) => {
    if (cfg.id) {
      await invoke("update_connection", { config: cfg });
    } else {
      await invoke("add_connection", { config: cfg });
    }
    setEditTarget(null);
    onRefresh();
  };

  const handleRemove = async (id: string) => {
    if (!await confirm(t.deleteConnectionConfirm)) return;
    await invoke("remove_connection", { id });
    onRefresh();
  };

  const handleDuplicate = async (id: string) => {
    const conn = connections.find(c => c.id === id);
    if (!conn) return;
    const { id: _drop, ...rest } = conn;
    await invoke("add_connection", { config: { ...rest, name: `${conn.name}${t.connectionCopySuffix}` } });
    onRefresh();
  };

  const handleCreateCollection = async (connectionId: string, db: string, name: string) => {
    await invoke("create_collection", { connectionId, dbName: db, collectionName: name });
    await refreshCollections(connectionId, db);
  };

  const handleCreateDatabase = async (connectionId: string, dbName: string, colName: string) => {
    await invoke("create_collection", { connectionId, dbName, collectionName: colName });
    await loadDatabases(connectionId);
    setNewDbInput(prev => ({ ...prev, [connectionId]: null }));
  };

  const handleDropCollection = async (connectionId: string, db: string, col: string) => {
    const env = connections.find(c => c.id === connectionId)?.environment ?? "development";
    if (!await guard(env, "dropCollection")) return;
    if (!await confirm(tpl(t.dropCollectionConfirm, { col }))) return;
    const key = `${connectionId}::${db}::${col}`;
    setDropping(prev => new Set(prev).add(key));
    try {
      await invoke("drop_collection", { connectionId, dbName: db, collectionName: col });
    } catch (e) {
      alert(String(e));
    } finally {
      setDropping(prev => { const n = new Set(prev); n.delete(key); return n; });
      await refreshCollections(connectionId, db);
    }
  };

  const handleDump = async (connectionId: string, db: string) => {
    const path = await save({
      defaultPath: `${db}_dump.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!path) return;
    try {
      const result: { collections: number; documents: number } = await invoke("dump_database", {
        connectionId, dbName: db, filePath: path,
      });
      alert(tpl(t.dumpSuccess, { col: result.collections, doc: result.documents.toLocaleString() }));
    } catch (e) {
      alert(tpl(t.dumpFail, { error: String(e) }));
    }
  };

  const handleRestore = async (connectionId: string, db: string) => {
    const env = connections.find(c => c.id === connectionId)?.environment ?? "development";
    if (!await guard(env, "restoreDatabase")) return;
    const path = await open({
      filters: [{ name: "ZIP", extensions: ["zip"] }],
      multiple: false,
    });
    if (!path) return;
    const dropBefore = await confirm(tpl(t.restoreConfirm, { db }));
    try {
      const result: { collections: number; documents: number } = await invoke("restore_database", {
        connectionId, dbName: db, filePath: path as string, dropBefore,
      });
      alert(tpl(t.restoreSuccess, { col: result.collections, doc: result.documents.toLocaleString() }));
    } catch (e) {
      alert(tpl(t.restoreFail, { error: String(e) }));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* ヘッダー */}
      <div style={{
        display: "flex", alignItems: "center",
        padding: "8px 10px", borderBottom: "1px solid var(--border)",
        background: "var(--bg3)", flexShrink: 0,
      }}>
        <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 13, flex: 1 }}>{t.connections}</span>
        <button
          onClick={() => setEditTarget("new")}
          className="primary"
          style={{ fontSize: 12, padding: "4px 10px" }}
        >
          {t.addConnection}
        </button>
      </div>

      {/* 接続設定モーダル */}
      {editTarget !== null && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.55)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={e => { if (e.target === e.currentTarget) setEditTarget(null); }}
        >
          <div style={{
            background: "var(--bg2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            width: 500,
            maxWidth: "92vw",
            maxHeight: "90vh",
            overflow: "auto",
            padding: 20,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
              <span style={{ color: "var(--accent2)", fontWeight: 700, fontSize: 14, flex: 1 }}>
                {editTarget === "new" ? t.newConnection : t.editConnection}
              </span>
              <button onClick={() => setEditTarget(null)} style={{ fontSize: 14, padding: "4px 10px" }}>✕</button>
            </div>
            <ConnectionForm
              initial={
                editTarget === "new"
                  ? defaultConnection()
                  : connections.find(c => c.id === editTarget) ?? defaultConnection()
              }
              onSave={handleSave}
              onCancel={() => setEditTarget(null)}
            />
          </div>
        </div>
      )}

      {/* ツリー */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {connections.map(conn => {
          const isConnected = connectedIds.includes(conn.id);
          const dbs = databases[conn.id] ?? [];
          const expandedSet = expandedDbs[conn.id] ?? new Set<string>();

          return (
            <div key={conn.id}>
              {/* 接続行 */}
              <div style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "5px 8px",
                background: "var(--bg2)",
                borderBottom: "1px solid var(--border)",
              }}>
                <span style={{ fontSize: 11, color: isConnected ? "var(--green)" : "var(--text-muted)" }}>
                  {isConnected ? "●" : "○"}
                </span>
                <span style={{
                  flex: 1, fontSize: 13, fontWeight: 600,
                  color: isConnected ? "var(--text)" : "var(--text-muted)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {conn.name}
                </span>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                  color: ENV_COLOR[conn.environment], border: `1px solid ${ENV_COLOR[conn.environment]}`,
                  flexShrink: 0,
                }}>
                  {t[ENV_LABEL_KEY[conn.environment]]}
                </span>
                {isConnected && (
                  <button
                    onClick={() => handleReload(conn.id)}
                    style={{ fontSize: 13, padding: "3px 7px", background: "none", flexShrink: 0 }}
                    title={t.reloadTitle}
                  >↻</button>
                )}
                {isConnected ? (
                  <button
                    onClick={() => handleDisconnect(conn.id)}
                    style={{ fontSize: 12, padding: "4px 10px", color: "var(--red)", flexShrink: 0 }}
                  >
                    {t.disconnect}
                  </button>
                ) : (
                  <button
                    onClick={() => handleConnect(conn.id)}
                    disabled={connecting === conn.id}
                    style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }}
                    className="primary"
                  >
                    {connecting === conn.id ? t.connecting : t.connect}
                  </button>
                )}
                <button
                  onClick={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setConnMenu({ id: conn.id, x: rect.right - 150, y: rect.bottom + 2 });
                  }}
                  style={{
                    fontSize: 12, padding: "4px 9px", flexShrink: 0,
                    lineHeight: 1, display: "flex", alignItems: "center",
                  }}
                  title={t.moreActions}
                >
                  ⋯
                </button>
              </div>

              {connMenu?.id === conn.id && (
                <ContextMenu
                  x={connMenu.x}
                  y={connMenu.y}
                  onClose={() => setConnMenu(null)}
                  items={[
                    { label: t.editConnection, onClick: () => setEditTarget(conn.id) },
                    { label: t.duplicateConnection, onClick: () => handleDuplicate(conn.id) },
                    { label: t.deleteConnection, onClick: () => handleRemove(conn.id), danger: true },
                  ]}
                />
              )}

              {/* 接続診断（進行中 or 失敗時） */}
              {(connecting === conn.id || connError[conn.id]) && (
                <div style={{ padding: "4px 10px", background: "var(--bg3)" }}>
                  <ConnectDiagnostics
                    sshEnabled={conn.ssh?.enabled ?? false}
                    progress={connProgress[conn.id] ?? {}}
                    error={connError[conn.id] ?? null}
                  />
                </div>
              )}

              {/* DB ツリー */}
              {isConnected && (
                <div style={{ paddingLeft: 8 }}>
                  {dbs.length === 0 && (
                    <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "4px 8px" }}>
                      {t.loadingDbs}
                    </div>
                  )}
                  {dbs.map(db => {
                    const isExpanded = expandedSet.has(db);
                    const colKey = `${conn.id}::${db}`;
                    const cols = collections[colKey] ?? [];

                    return (
                      <DbNode
                        key={db}
                        db={db}
                        isExpanded={isExpanded}
                        collections={cols}
                        onToggle={() => toggleDb(conn.id, db)}
                        onSelectDb={() => onSelect({ connectionId: conn.id, db, collection: null })}
                        onSelectCollection={col => onSelect({ connectionId: conn.id, db, collection: col })}
                        selectedCollection={
                          selected?.connectionId === conn.id && selected.db === db
                            ? selected.collection
                            : null
                        }
                        onCreateCollection={name => handleCreateCollection(conn.id, db, name)}
                        onReload={() => refreshCollections(conn.id, db)}
                        droppingCollections={new Set(cols.filter(c => dropping.has(`${conn.id}::${db}::${c}`)))}
                        onDropCollection={col => handleDropCollection(conn.id, db, col)}
                        onDump={() => handleDump(conn.id, db)}
                        onRestore={() => handleRestore(conn.id, db)}
                      />
                    );
                  })}

                  {/* DB作成フォーム */}
                  {newDbInput[conn.id] ? (
                    <div style={{ padding: "4px 8px" }}>
                      <input
                        value={newDbInput[conn.id]!.dbName}
                        onChange={e => setNewDbInput(prev => ({ ...prev, [conn.id]: { ...prev[conn.id]!, dbName: e.target.value } }))}
                        placeholder={t.newDbNamePlaceholder}
                        style={{ width: "100%", marginBottom: 3, boxSizing: "border-box" }}
                        autoFocus
                        onKeyDown={e => e.key === "Escape" && setNewDbInput(prev => ({ ...prev, [conn.id]: null }))}
                      />
                      <div style={{ display: "flex", gap: 3 }}>
                        <input
                          value={newDbInput[conn.id]!.colName}
                          onChange={e => setNewDbInput(prev => ({ ...prev, [conn.id]: { ...prev[conn.id]!, colName: e.target.value } }))}
                          placeholder={t.newDbColPlaceholder}
                          style={{ flex: 1 }}
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              const s = newDbInput[conn.id]!;
                              if (s.dbName.trim() && s.colName.trim())
                                handleCreateDatabase(conn.id, s.dbName.trim(), s.colName.trim());
                            }
                            if (e.key === "Escape") setNewDbInput(prev => ({ ...prev, [conn.id]: null }));
                          }}
                        />
                        <button onClick={() => setNewDbInput(prev => ({ ...prev, [conn.id]: null }))} style={{ fontSize: 12 }}>✕</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() => setNewDbInput(prev => ({ ...prev, [conn.id]: { dbName: "", colName: "" } }))}
                      style={{ color: "var(--text-muted)", fontSize: 12, padding: "4px 8px", cursor: "pointer" }}
                    >
                      {t.addDatabase}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {connections.length === 0 && (
          <div style={{ color: "var(--text-muted)", textAlign: "center", padding: "24px 8px", fontSize: 12 }}>
            {t.noConnections}
          </div>
        )}
      </div>
    </div>
  );
}

function DbNode({
  db, isExpanded, collections, onToggle, onSelectDb, onSelectCollection,
  selectedCollection, onCreateCollection, onReload, droppingCollections, onDropCollection, onDump, onRestore,
}: {
  db: string;
  isExpanded: boolean;
  collections: string[];
  onToggle: () => void;
  onSelectDb: () => void;
  onSelectCollection: (col: string) => void;
  selectedCollection: string | null;
  onCreateCollection: (name: string) => void;
  onReload: () => void;
  droppingCollections: Set<string>;
  onDropCollection: (col: string) => void;
  onDump: () => void;
  onRestore: () => void;
}) {
  const { t } = useI18n();
  const [newColName, setNewColName] = useState("");
  const [showInput, setShowInput] = useState(false);

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 6px", cursor: "pointer", borderRadius: 3,
        }}
      >
        <span style={{ fontSize: 12, color: "var(--text-muted)", width: 12 }}>
          {isExpanded ? "▾" : "▸"}
        </span>
        <span style={{ color: "var(--yellow)", fontSize: 13, flex: 1 }}>{db}</span>
        <button
          onClick={e => { e.stopPropagation(); onSelectDb(); }}
          style={{
            fontSize: 13, padding: "3px 7px", background: "none",
            opacity: selectedCollection === null ? 1 : 0.5,
            color: selectedCollection === null ? "var(--accent)" : undefined,
          }}
          title={t.queryPad}
        >⌨</button>
        <button
          onClick={e => { e.stopPropagation(); onReload(); }}
          style={{ fontSize: 13, padding: "3px 7px", background: "none", opacity: 0.6 }}
          title={t.reloadTitle}
        >↻</button>
        <button
          onClick={e => { e.stopPropagation(); onDump(); }}
          style={{ fontSize: 13, padding: "3px 7px", background: "none", opacity: 0.6 }}
          title={t.dumpTitle}
        >⬇</button>
        <button
          onClick={e => { e.stopPropagation(); onRestore(); }}
          style={{ fontSize: 13, padding: "3px 7px", background: "none", opacity: 0.6 }}
          title={t.restoreTitle}
        >⬆</button>
      </div>

      {isExpanded && (
        <div style={{ paddingLeft: 16 }}>
          {collections.map(col => {
            const isDropping = droppingCollections.has(col);
            return (
            <div
              key={col}
              onClick={() => { if (!isDropping) onSelectCollection(col); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "2px 6px", cursor: isDropping ? "progress" : "pointer", borderRadius: 3,
                opacity: isDropping ? 0.5 : 1,
                background: selectedCollection === col ? "var(--surface2)" : "transparent",
              }}
            >
              <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {col}
              </span>
              <button
                onClick={e => { e.stopPropagation(); onDropCollection(col); }}
                disabled={isDropping}
                style={{ fontSize: 12, padding: "2px 6px", color: "var(--text-muted)", background: "none", opacity: 0.5 }}
                title={t.deleteDoc}
              >
                {isDropping ? "⏳" : "✕"}
              </button>
            </div>
            );
          })}

          {showInput ? (
            <div style={{ display: "flex", gap: 3, padding: "2px 0" }}>
              <input
                value={newColName}
                onChange={e => setNewColName(e.target.value)}
                placeholder={t.newCollectionPlaceholder}
                style={{ flex: 1 }}
                onKeyDown={e => {
                  if (e.key === "Enter" && newColName.trim()) {
                    onCreateCollection(newColName.trim());
                    setNewColName("");
                    setShowInput(false);
                  }
                  if (e.key === "Escape") setShowInput(false);
                }}
                autoFocus
              />
              <button onClick={() => setShowInput(false)} style={{ fontSize: 12 }}>✕</button>
            </div>
          ) : (
            <div
              onClick={() => setShowInput(true)}
              style={{ color: "var(--text-muted)", fontSize: 12, padding: "3px 6px", cursor: "pointer" }}
            >
              {t.addCollection}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
