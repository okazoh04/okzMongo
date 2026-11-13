import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ConnectionConfig, SelectedItem } from "./types";
import { useI18n, LOCALES } from "./i18n";
import Sidebar from "./components/Sidebar";
import DocumentList from "./components/DocumentList";
import QueryPad from "./components/QueryPad";
import About from "./components/About";
import TitleBar, { ResizeHandles } from "./components/TitleBar";
import PolicySettings from "./components/PolicySettings";
import QueryLogPanel, { QueryLogEntry } from "./components/QueryLogPanel";
import { ENV_COLOR } from "./policy";
import { exprErrorMessage, mongoExprToJson } from "./lib/mongoExpr";
import { useContentAssist } from "./lib/useContentAssist";

const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 600;
// メモリ肥大を避けるため、保持する履歴は直近この件数まで
const QUERY_LOG_MAX = 500;

// タブごとに保持する表示状態（フィルタ・サブタブ）
interface TabState {
  filterInput: string;
  filterJson: string;
  filterError: string | null;
  subTab: "documents" | "query";
}
const DEFAULT_TAB_STATE: TabState = { filterInput: "{}", filterJson: "{}", filterError: null, subTab: "documents" };
const tabKey = (s: SelectedItem) => `${s.connectionId}::${s.db}::${s.collection ?? ""}`;

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  // 開いているタブ（コレクション／DB単位）。タブごとの表示状態は tabStates に保持する
  const [openTabs, setOpenTabs] = useState<SelectedItem[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});
  const selected = openTabs.find(s => tabKey(s) === activeKey) ?? null;
  const { filterInput, filterError, subTab: activeTab } =
    (activeKey && tabStates[activeKey]) || DEFAULT_TAB_STATE;
  const updateActiveTab = (patch: Partial<TabState>) => {
    if (!activeKey) return;
    setTabStates(prev => ({ ...prev, [activeKey]: { ...(prev[activeKey] ?? DEFAULT_TAB_STATE), ...patch } }));
  };
  const setFilterInput = (v: string) => updateActiveTab({ filterInput: v });
  const setFilterJson = (v: string) => updateActiveTab({ filterJson: v });
  const setFilterError = (v: string | null) => updateActiveTab({ filterError: v });
  const setActiveTab = (v: "documents" | "query") => updateActiveTab({ subTab: v });
  const [showAbout, setShowAbout] = useState(false);
  const [showPolicySettings, setShowPolicySettings] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("okzmongo-sidebar-width"));
    return saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH ? saved : 260;
  });
  const isResizingSidebar = useRef(false);
  const [queryLog, setQueryLog] = useState<QueryLogEntry[]>([]);
  const [showQueryLog, setShowQueryLog] = useState(() => localStorage.getItem("okzmongo-query-log") === "1");

  const filterAssist = useContentAssist({
    mode: "expr",
    connectionId: selected?.connectionId,
    db: selected?.db,
    collection: selected?.collection,
    setValue: v => { setFilterInput(v); setFilterError(null); },
  });

  // フィルタ欄は JavaScript 式（キーの "" 省略・ObjectId(...) 等）で書け、Extended JSON に変換して渡す
  const applyFilter = () => {
    try {
      setFilterJson(mongoExprToJson(filterInput, "{}"));
      setFilterError(null);
    } catch (e) {
      setFilterError(`${t.invalidJson}: ${exprErrorMessage(e)}`);
    }
  };

  const loadConnections = async () => {
    const conns: ConnectionConfig[] = await invoke("list_connections");
    setConnections(conns);
  };

  const loadConnectedIds = async () => {
    const ids: string[] = await invoke("list_connected_ids");
    setConnectedIds(ids);
  };

  useEffect(() => {
    loadConnections();
    loadConnectedIds();
  }, []);

  // パネルを閉じていても履歴は溜め続けるため、購読は常時行う
  useEffect(() => {
    const unlisten = listen<QueryLogEntry>("query-log", e => {
      setQueryLog(prev => [...prev, e.payload].slice(-QUERY_LOG_MAX));
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const toggleQueryLog = () => {
    setShowQueryLog(v => {
      localStorage.setItem("okzmongo-query-log", v ? "0" : "1");
      return !v;
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingSidebar.current) return;
      const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX));
      setSidebarWidth(width);
    };
    const handleMouseUp = () => {
      if (!isResizingSidebar.current) return;
      isResizingSidebar.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth(w => {
        localStorage.setItem("okzmongo-sidebar-width", String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleSidebarResizeStart = () => {
    isResizingSidebar.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleConnect = (id: string) => {
    setConnectedIds(prev => prev.includes(id) ? prev : [...prev, id]);
  };

  const handleDisconnect = (id: string) => {
    setConnectedIds(prev => prev.filter(x => x !== id));
    const remaining = openTabs.filter(s => s.connectionId !== id);
    setOpenTabs(remaining);
    if (selected?.connectionId === id) {
      const last = remaining[remaining.length - 1];
      setActiveKey(last ? tabKey(last) : null);
    }
  };

  // 既に開いているタブは切り替えるだけ（フィルタ等の状態を保持）。未済なら新規タブを追加
  const handleSelect = (item: SelectedItem) => {
    const key = tabKey(item);
    setOpenTabs(prev => prev.some(s => tabKey(s) === key) ? prev : [...prev, item]);
    setTabStates(prev => prev[key] ? prev : {
      ...prev,
      // DBレベル選択時はクエリタブ、コレクション選択時はドキュメントタブへ
      [key]: { ...DEFAULT_TAB_STATE, subTab: item.collection === null ? "query" : "documents" },
    });
    setActiveKey(key);
  };

  const closeTab = (key: string) => {
    const idx = openTabs.findIndex(s => tabKey(s) === key);
    const next = openTabs.filter(s => tabKey(s) !== key);
    setOpenTabs(next);
    if (key === activeKey) {
      // 閉じたタブの右隣（無ければ左隣）をアクティブにする
      const neighbor = next[idx] ?? next[idx - 1];
      setActiveKey(neighbor ? tabKey(neighbor) : null);
    }
    setTabStates(prev => {
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
  };

  const activeConn = selected
    ? connections.find(c => c.id === selected.connectionId)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <TitleBar
        onOpenSettings={() => setShowPolicySettings(true)}
        onOpenAbout={() => setShowAbout(true)}
        breadcrumb={activeConn && selected && (
          <>
            <span data-tauri-drag-region style={{ color: "var(--green)" }}>{activeConn.name}</span>
            <span data-tauri-drag-region className="titlebar-sep">▸</span>
            <span data-tauri-drag-region style={{ color: "var(--yellow)" }}>{selected.db}</span>
            <span data-tauri-drag-region className="titlebar-sep">▸</span>
            <span data-tauri-drag-region>{selected.collection}</span>
          </>
        )}
      />

      {/* ボディ */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* サイドバー */}
        <div style={{
          width: sidebarWidth,
          borderRight: "1px solid var(--border)",
          background: "var(--bg2)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          <Sidebar
            connections={connections}
            connectedIds={connectedIds}
            selected={selected}
            onSelect={handleSelect}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onRefresh={loadConnections}
          />
        </div>

        {/* サイドバー幅リサイズハンドル */}
        <div
          onMouseDown={handleSidebarResizeStart}
          style={{
            width: 5,
            marginLeft: -2.5,
            marginRight: -2.5,
            cursor: "col-resize",
            flexShrink: 0,
            zIndex: 1,
            position: "relative",
          }}
        />

        {/* メインエリア（上端の帯で接続の環境種別を色で示す） */}
        <div style={{
          flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
          borderTop: `4px solid ${activeConn ? ENV_COLOR[activeConn.environment] : "transparent"}`,
        }}>
          {openTabs.length > 0 && (
            <div style={{
              display: "flex",
              background: "var(--bg3)",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              overflowX: "auto",
            }}>
              {openTabs.map(tab => {
                const key = tabKey(tab);
                const isActive = key === activeKey;
                const connName = connections.find(c => c.id === tab.connectionId)?.name ?? "";
                return (
                  <div
                    key={key}
                    title={`${connName} ▸ ${tab.db}${tab.collection !== null ? ` ▸ ${tab.collection}` : ""}`}
                    onClick={() => setActiveKey(key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0 6px 0 12px",
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      background: isActive ? "var(--bg2)" : "transparent",
                      color: isActive ? "var(--text)" : "var(--text-muted)",
                      borderRight: "1px solid var(--border)",
                      borderTop: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                    }}
                  >
                    <span>{tab.collection !== null ? `${tab.db} ▸ ${tab.collection}` : tab.db}</span>
                    <button
                      title={t.close}
                      onClick={e => { e.stopPropagation(); closeTab(key); }}
                      style={{
                        border: "none", background: "none", padding: "0 4px",
                        color: "inherit", fontSize: 14, cursor: "pointer",
                      }}
                    >×</button>
                  </div>
                );
              })}
            </div>
          )}

          {selected ? (
            <>
              {/* タブバー（コレクション選択時のみ両タブ表示、DBレベルはクエリのみ） */}
              <div style={{
                display: "flex",
                alignItems: "center",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg2)",
                flexShrink: 0,
              }}>
                {selected.collection !== null && (
                  <>
                    <button
                      onClick={() => setActiveTab("documents")}
                      style={{
                        fontSize: 13, padding: "8px 18px", border: "none", borderRadius: 0,
                        borderBottom: activeTab === "documents" ? "2px solid var(--accent)" : "2px solid transparent",
                        background: "none",
                        color: activeTab === "documents" ? "var(--accent)" : "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >{t.documents}</button>
                    <button
                      onClick={() => setActiveTab("query")}
                      style={{
                        fontSize: 13, padding: "8px 18px", border: "none", borderRadius: 0,
                        borderBottom: activeTab === "query" ? "2px solid var(--accent)" : "2px solid transparent",
                        background: "none",
                        color: activeTab === "query" ? "var(--accent)" : "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >{t.queryPad}</button>
                  </>
                )}
                {selected.collection === null && (
                  <span style={{ padding: "6px 16px", fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>
                    {t.queryPad}
                  </span>
                )}

                {/* ドキュメントタブのフィルタ入力 */}
                {activeTab === "documents" && selected.collection !== null && (
                  <div style={{ flex: 1, display: "flex", gap: 6, padding: "4px 12px 4px 4px" }}>
                    <input
                      ref={filterAssist.ref as React.RefObject<HTMLInputElement>}
                      value={filterInput}
                      onChange={filterAssist.onInput}
                      onBlur={filterAssist.onBlur}
                      placeholder='{field: "value"}'
                      style={{
                        flex: 1, fontFamily: "monospace",
                        ...(filterError ? { borderColor: "var(--red)" } : {}),
                      }}
                      onKeyDown={e => {
                        if (filterAssist.onKeyDown(e)) return;
                        if (e.key === "Enter") applyFilter();
                      }}
                    />
                    {filterAssist.dropdown}
                    <button className="primary" onClick={applyFilter}>{t.search}</button>
                    <button onClick={() => { setFilterInput("{}"); setFilterJson("{}"); setFilterError(null); }}>{t.clear}</button>
                    {filterError && (
                      <span title={filterError} style={{
                        alignSelf: "center", maxWidth: 240, fontSize: 11, color: "var(--red)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{filterError}</span>
                    )}
                  </div>
                )}
              </div>

              <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                {/* 開いている全タブを常時マウントし、非表示にするだけにする（読込済みデータや入力内容を保持） */}
                {openTabs.map(tab => {
                  const key = tabKey(tab);
                  const isActive = key === activeKey;
                  const st = tabStates[key] ?? DEFAULT_TAB_STATE;
                  const env = connections.find(c => c.id === tab.connectionId)?.environment ?? "development";
                  const showDocs = tab.collection !== null && st.subTab === "documents";
                  const pane = (show: boolean): React.CSSProperties => ({
                    display: isActive && show ? "flex" : "none",
                    flex: 1, flexDirection: "column", overflow: "hidden",
                  });
                  return (
                    <Fragment key={key}>
                      {tab.collection !== null && (
                        <div style={pane(showDocs)}>
                          <DocumentList
                            connectionId={tab.connectionId}
                            db={tab.db}
                            collection={tab.collection}
                            filterJson={st.filterJson}
                            environment={env}
                          />
                        </div>
                      )}
                      <div style={pane(!showDocs)}>
                        <QueryPad
                          connectionId={tab.connectionId}
                          db={tab.db}
                          initialQuery={tab.collection ? `db.${tab.collection}.find({})` : undefined}
                          environment={env}
                        />
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}>
              {t.selectCollection}
            </div>
          )}
        </div>
      </div>

      {showQueryLog && (
        <QueryLogPanel
          entries={queryLog}
          connectionName={id => connections.find(c => c.id === id)?.name ?? id}
          onClear={() => setQueryLog([])}
          onClose={toggleQueryLog}
        />
      )}

      {/* ステータスバー */}
      <div style={{
        background: "var(--bg3)",
        borderTop: "1px solid var(--border)",
        height: 24,
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        flexShrink: 0,
        position: "relative",
      }}>
        <button
          onClick={() => setShowLangPicker(p => !p)}
          title={t.langLabel}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 14, padding: "0 4px", color: "var(--text-muted)", lineHeight: 1,
          }}
        >🌐</button>
        <button
          onClick={toggleQueryLog}
          style={{
            background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: "0 6px",
            color: showQueryLog ? "var(--accent)" : "var(--text-muted)",
          }}
        >{t.queryLog} ({queryLog.length})</button>
        {showLangPicker && (
          <>
            <div
              onClick={() => setShowLangPicker(false)}
              style={{ position: "fixed", inset: 0, zIndex: 99 }}
            />
            <div style={{
              position: "absolute",
              bottom: 28,
              left: 0,
              background: "var(--bg2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              overflow: "hidden",
              zIndex: 100,
              minWidth: 160,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}>
              {LOCALES.map(l => (
                <button
                  key={l.value}
                  onClick={() => { setLocale(l.value); setShowLangPicker(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "6px 16px",
                    background: l.value === locale ? "var(--accent)" : "none",
                    color: l.value === locale ? "white" : "var(--text)",
                    border: "none", cursor: "pointer", fontSize: 13,
                  }}
                >{l.label}</button>
              ))}
            </div>
          </>
        )}
      </div>
      {showAbout && <About onClose={() => setShowAbout(false)} />}
      {showPolicySettings && <PolicySettings onClose={() => setShowPolicySettings(false)} />}
      <ResizeHandles />
    </div>
  );
}
