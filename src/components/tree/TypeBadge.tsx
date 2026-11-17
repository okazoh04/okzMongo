import { useState } from "react";
import { TYPE_ICON, TYPE_COLOR, EDITABLE_TYPES, type BsonTypeTag } from "../../lib/bsonTypes";

interface Props {
  type: BsonTypeTag;
  onChangeType?: (newType: BsonTypeTag) => void;
  readOnly?: boolean;
}

const LABELS: Record<BsonTypeTag, string> = {
  objectId: "ObjectId",
  string: "String",
  int32: "Int32",
  int64: "Int64",
  double: "Double",
  date: "Date",
  bool: "Boolean",
  null: "Null",
  array: "Array",
  object: "Object",
  unknown: "Unknown",
};

export default function TypeBadge({ type, onChangeType, readOnly }: Props) {
  const [open, setOpen] = useState(false);
  const clickable = !readOnly && !!onChangeType;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        onClick={(e) => {
          if (clickable) {
            e.stopPropagation();
            setOpen((o) => !o);
          }
        }}
        title={LABELS[type]}
        style={{
          display: "inline-block",
          color: "var(--bg3)",
          background: TYPE_COLOR[type],
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1.4,
          letterSpacing: 0.3,
          borderRadius: 3,
          padding: "1px 4px",
          cursor: clickable ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        {TYPE_ICON[type]}
      </span>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              zIndex: 100,
              background: "var(--bg2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              minWidth: 100,
            }}
          >
            {EDITABLE_TYPES.map((t) => (
              <button
                key={t}
                onClick={(e) => {
                  e.stopPropagation();
                  onChangeType?.(t);
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 12px",
                  background: t === type ? "var(--accent)" : "none",
                  color: t === type ? "white" : "var(--text)",
                  border: "none",
                  fontSize: 12,
                }}
              >
                {LABELS[t]}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
