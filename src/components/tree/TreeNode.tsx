import { useEffect, useRef, useState } from "react";
import {
  inferType,
  formatDisplayValue,
  formatJsonPreview,
  coerceType,
  convertType,
  unwrapValue,
  type BsonTypeTag,
} from "../../lib/bsonTypes";
import TypeBadge from "./TypeBadge";
import ValueEditor from "./ValueEditor";
import { TREE_GRID_TEMPLATE } from "./gridLayout";
import { useI18n } from "../../i18n";

interface KeyEditorProps {
  initialValue: string;
  onCommit: (newKey: string) => string | null;
  onCancel: () => void;
  onSaveNow: () => void;
}

function KeyEditor({ initialValue, onCommit, onCancel, onSaveNow }: KeyEditorProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState(initialValue);
  const [err, setErr] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (thenSave: boolean) => {
    if (done.current) return;
    const trimmed = val.trim();
    if (!trimmed) {
      setErr(t.treeKeyEmpty);
      return;
    }
    const error = onCommit(trimmed);
    if (error) {
      setErr(error);
      return;
    }
    done.current = true;
    setErr(null);
    if (thenSave) onSaveNow();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <input
        ref={ref}
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.ctrlKey || e.metaKey);
          }
        }}
        onBlur={() => commit(false)}
        style={{ fontSize: 13, padding: "4px 8px", width: 160 }}
      />
      {err && <span style={{ color: "var(--red)", fontSize: 11 }}>{err}</span>}
    </div>
  );
}

export interface TreeNodeProps {
  path: string;
  fieldKey: string;
  value: unknown;
  depth: number;
  /** 表示中のデータ行のみを数えた通し番号（縞模様の判定に使用。配列インデックス由来の不変値） */
  rowIndex: number;
  isArrayItem: boolean;
  expanded: boolean;
  editingPath: string | null;
  editingField: "key" | "value" | null;
  onToggleExpand: (path: string) => void;
  onStartEditValue: (path: string) => void;
  onStartEditKey: (path: string) => void;
  onCommitEdit: (path: string, newValue: unknown) => void;
  onCommitKey: (path: string, newKey: string) => string | null;
  onSaveNow: () => void;
  onCancelEdit: () => void;
  onDelete: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, value: unknown) => void;
  readOnly?: boolean;
}

export default function TreeNode(props: TreeNodeProps) {
  const {
    path,
    fieldKey,
    value,
    depth,
    rowIndex,
    isArrayItem,
    expanded,
    editingPath,
    editingField,
    onToggleExpand,
    onStartEditValue,
    onStartEditKey,
    onCommitEdit,
    onCommitKey,
    onSaveNow,
    onCancelEdit,
    onDelete,
    onContextMenu,
    readOnly,
  } = props;
  const { t } = useI18n();
  const type = inferType(value);
  const isContainer = type === "object" || type === "array";
  const isEditingValue = editingPath === path && editingField === "value";
  const isEditingKey = editingPath === path && editingField === "key";
  const canRenameKey = !isArrayItem && !readOnly;
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);

  const applyRaw = (raw: unknown) => {
    const result = coerceType(raw, type);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onCommitEdit(path, result.value);
  };

  const applyType = (newType: BsonTypeTag) => {
    const result = convertType(value, newType);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onCommitEdit(path, result.value);
    // null から型を選んだ場合は、続けて値を入力できるよう編集モードへ移る
    if (type === "null" && newType !== "null" && newType !== "bool" && newType !== "array" && newType !== "object") {
      onStartEditValue(path);
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: TREE_GRID_TEMPLATE,
        alignItems: "center",
        columnGap: 6,
        padding: "2px 4px",
        cursor: isContainer ? "pointer" : "default",
        background: rowIndex % 2 === 1 ? "rgba(255, 255, 255, 0.035)" : "transparent",
      }}
      onClick={() => isContainer && onToggleExpand(path)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, path, value);
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: depth * 16, minWidth: 0 }}>
        <span style={{ width: 12, color: "var(--text-muted)", flexShrink: 0 }}>
          {isContainer ? (expanded ? "▾" : "▸") : ""}
        </span>
        {isEditingKey ? (
          <KeyEditor
            initialValue={fieldKey}
            onCommit={(newKey) => onCommitKey(path, newKey)}
            onSaveNow={onSaveNow}
            onCancel={onCancelEdit}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              if (canRenameKey) {
                e.stopPropagation();
                onStartEditKey(path);
              }
            }}
            title={canRenameKey ? t.treeRenameFieldHint : undefined}
            style={{
              color: "var(--text-sub)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              cursor: canRenameKey ? "text" : undefined,
            }}
          >
            {fieldKey}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {!isContainer && isEditingValue ? (
          <ValueEditor
            type={type}
            initialRaw={unwrapValue(value)}
            onCommit={applyRaw}
            onSaveNow={onSaveNow}
            onCancel={onCancelEdit}
          />
        ) : (
          <span
            onClick={(e) => {
              if (!isContainer && !readOnly) {
                e.stopPropagation();
                onStartEditValue(path);
              }
            }}
            title={isContainer ? formatJsonPreview(value) : formatDisplayValue(value)}
            style={{
              color: isContainer ? "var(--text-muted)" : "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
              // 空文字の値は表示が空になり高さが潰れてクリックできなくなるため、最低高さを確保する
              minHeight: 22,
              lineHeight: "22px",
              cursor: !isContainer && !readOnly ? "text" : undefined,
            }}
          >
            {isContainer ? formatJsonPreview(value) : formatDisplayValue(value)}
          </span>
        )}
        {error && <span style={{ color: "var(--red)", fontSize: 11 }}>{error}</span>}
      </div>
      <div>
        <TypeBadge type={type} onChangeType={readOnly ? undefined : applyType} readOnly={readOnly} />
      </div>
      <div>
        {!readOnly && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(path);
            }}
            title={t.treeDeleteField}
            style={{
              fontSize: 12,
              padding: "3px 8px",
              color: "var(--red)",
              background: "none",
              opacity: hover ? 1 : 0.4,
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
