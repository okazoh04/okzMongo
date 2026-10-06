import { createContext, useCallback, useContext, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { EnvironmentTier } from "./types";
import { usePolicy } from "./PolicyProvider";
import { useI18n } from "./i18n";

/** アプリ内クリップボード。実データは持たず「どこから何をコピーしたか」だけを保持し、貼り付け時にRust側で直接転送する */
export interface ClipItem {
  kind: "collection" | "documents";
  connectionId: string;
  db: string;
  collection: string;
  filterJson: string;
  /** 表示用の件数（documents のみ） */
  count?: number;
}

export interface PasteTarget {
  connectionId: string;
  db: string;
  collection: string;
  environment: EnvironmentTier;
}

interface CopyStats {
  copied: number;
  skipped: number;
  indexes: number;
}

interface ClipboardContextValue {
  clip: ClipItem | null;
  copy: (item: ClipItem) => void;
  /** 貼り付け。成功時は true（呼び出し側で再読み込みする） */
  paste: (target: PasteTarget) => Promise<boolean>;
}

const ClipboardContext = createContext<ClipboardContextValue | null>(null);

export function useClipboard(): ClipboardContextValue {
  const ctx = useContext(ClipboardContext);
  if (!ctx) throw new Error("useClipboard must be used within ClipboardProvider");
  return ctx;
}

export function clipLabel(c: ClipItem): string {
  return c.kind === "collection" ? `${c.db}.${c.collection}` : `${c.db}.${c.collection} (${c.count ?? "?"})`;
}

export function ClipboardProvider({ children }: { children: ReactNode }) {
  const { t, tpl } = useI18n();
  const { guard } = usePolicy();
  const [clip, setClip] = useState<ClipItem | null>(null);

  const copy = useCallback((item: ClipItem) => setClip(item), []);

  const paste = useCallback(async (target: PasteTarget): Promise<boolean> => {
    if (!clip) { alert(t.clipboardEmpty); return false; }
    const op = clip.kind === "collection" ? "importCollection" : "insertDoc";
    if (!await guard(target.environment, op)) return false;

    const same = clip.connectionId === target.connectionId
      && clip.db === target.db && clip.collection === target.collection;
    // 同一コレクションへの貼り付けは _id が必ず衝突するため、新しい _id を採番して複製する
    if (same && !await confirm(t.pasteSameCollectionConfirm)) return false;

    try {
      const r: CopyStats = await invoke("copy_documents", {
        srcConnectionId: clip.connectionId,
        srcDb: clip.db,
        srcCollection: clip.collection,
        filterJson: clip.filterJson,
        dstConnectionId: target.connectionId,
        dstDb: target.db,
        dstCollection: target.collection,
        regenerateIds: same,
        copyIndexes: clip.kind === "collection" && !same,
      });
      alert(tpl(t.pasteDone, { copied: r.copied.toLocaleString(), skipped: r.skipped.toLocaleString(), indexes: r.indexes }));
      return true;
    } catch (e) {
      alert(tpl(t.pasteFail, { error: String(e) }));
      return false;
    }
  }, [clip, guard, t, tpl]);

  return (
    <ClipboardContext.Provider value={{ clip, copy, paste }}>
      {children}
    </ClipboardContext.Provider>
  );
}
