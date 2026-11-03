import type { CSSProperties, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "../i18n";

// `@tauri-apps/api/window` は ResizeDirection を export していないので、同じ値の型をここに置く
type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

interface Props {
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  /** アプリ名の右に出す現在地（接続先 ▸ DB ▸ コレクション）。省略可 */
  breadcrumb?: ReactNode;
}

// 自前のタイトルバー（okzTorrent・okzTerminal・okzFile と同じ作り）。OS の枠は使わない（tauri.conf.json の decorations: false）。
// 左にアプリ名と現在地、右に設定・About・窓の操作。余白（data-tauri-drag-region）のドラッグで窓を動かし、
// ダブルクリックで最大化を切り替える。ボタンには drag-region を付けないので、ボタンは普通に押せる。

// 窓の枠の掴みしろ（端の細い帯。角は斜めに掴める）
const EDGE = 5;
const CORNER = 10;

const RESIZE_HANDLES: { dir: ResizeDirection; style: CSSProperties }[] = [
  { dir: "North", style: { top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" } },
  { dir: "South", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" } },
  { dir: "West", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" } },
  { dir: "East", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" } },
  { dir: "NorthWest", style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" } },
  { dir: "NorthEast", style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" } },
  { dir: "SouthWest", style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" } },
  { dir: "SouthEast", style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" } },
];

/** 窓の枠を掴んで大きさを変える帯（端と四隅）。窓の上に重ねて、どこでも変えられるようにする */
export function ResizeHandles() {
  return (
    <>
      {RESIZE_HANDLES.map(({ dir, style }) => (
        <div
          key={dir}
          style={{ position: "fixed", zIndex: 9000, ...style }}
          onMouseDown={e => {
            if (e.button === 0) getCurrentWindow().startResizeDragging(dir);
          }}
        />
      ))}
    </>
  );
}

export default function TitleBar({ onOpenSettings, onOpenAbout, breadcrumb }: Props) {
  const { t } = useI18n();
  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-title" data-tauri-drag-region>okzMongo</span>
      {breadcrumb && (
        <span className="titlebar-crumb" data-tauri-drag-region>{breadcrumb}</span>
      )}
      <div style={{ flex: 1 }} data-tauri-drag-region />
      <button className="winbtn" title={t.policySettingsTitle} onClick={onOpenSettings}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6" />
        </svg>
      </button>
      <button className="winbtn" title={t.about} onClick={onOpenAbout}>
        <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6.6 6.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.4" />
          <circle cx="9" cy="13.4" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button className="winbtn" title={t.minimize} onClick={() => win.minimize()}>
        <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M4 9h10" />
        </svg>
      </button>
      <button className="winbtn" title={t.maximize} onClick={() => win.toggleMaximize()}>
        <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="4.5" y="4.5" width="9" height="9" />
        </svg>
      </button>
      <button className="winbtn winclose" title={t.close} onClick={() => win.close()}>
        <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="butt" aria-hidden="true">
          <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
