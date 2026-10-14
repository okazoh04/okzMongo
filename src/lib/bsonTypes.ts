// バックエンド(bson_json.rs)が扱うExtended JSON表現（$oid/$date/$numberInt/$numberLong）
// の判定・表示整形・型変更ロジック。BSON型情報を保持したまま編集するためのユーティリティ。

export type BsonTypeTag =
  | "objectId"
  | "string"
  | "int32"
  | "int64"
  | "double"
  | "date"
  | "bool"
  | "null"
  | "array"
  | "object"
  | "unknown";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function inferType(value: unknown): BsonTypeTag {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "double";
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      if (typeof value.$oid === "string") return "objectId";
      if ("$date" in value) return "date";
      if (typeof value.$numberInt === "string") return "int32";
      if (typeof value.$numberLong === "string") return "int64";
    }
    return "object";
  }
  return "unknown";
}

/** 編集用に生の値（number/string/boolean等）を取り出す */
export function unwrapValue(value: unknown): unknown {
  switch (inferType(value)) {
    case "objectId":
      return (value as { $oid: string }).$oid;
    case "date": {
      const d = (value as { $date: unknown }).$date;
      if (typeof d === "number") return d;
      if (isPlainObject(d) && typeof d.$numberLong === "string") return Number(d.$numberLong);
      return Number(d);
    }
    case "int32":
      return Number((value as { $numberInt: string }).$numberInt);
    case "int64":
      return Number((value as { $numberLong: string }).$numberLong);
    default:
      return value;
  }
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false; error: string };

/** 値を指定した型へ変換する。失敗時は変換前の値を維持できるようokフラグで返す */
export function coerceType(value: unknown, newType: BsonTypeTag): CoerceResult {
  const raw = unwrapValue(value);
  switch (newType) {
    case "string": {
      if (raw === null || raw === undefined) return { ok: true, value: "" };
      if (typeof raw === "object") return { ok: false, error: "オブジェクト/配列は文字列に変換できません" };
      return { ok: true, value: String(raw) };
    }
    case "int32": {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "整数に変換できません" };
      if (n < -2147483648 || n > 2147483647) return { ok: false, error: "Int32の範囲を超えています" };
      return { ok: true, value: { $numberInt: String(n) } };
    }
    case "int64": {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "整数に変換できません" };
      return { ok: true, value: { $numberLong: String(n) } };
    }
    case "double": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: "数値に変換できません" };
      return { ok: true, value: n };
    }
    case "bool":
      return { ok: true, value: typeof raw === "boolean" ? raw : false };
    case "null":
      return { ok: true, value: null };
    case "date": {
      if (raw === null || raw === undefined) return { ok: true, value: { $date: Date.now() } };
      const n = typeof raw === "number" ? raw : Date.parse(String(raw));
      if (!Number.isFinite(n)) return { ok: false, error: "日付に変換できません" };
      return { ok: true, value: { $date: n } };
    }
    case "objectId": {
      if (raw === null || raw === undefined) return { ok: true, value: { $oid: "0".repeat(24) } };
      const s = String(raw);
      if (!/^[0-9a-fA-F]{24}$/.test(s)) return { ok: false, error: "ObjectIdは24桁の16進数である必要があります" };
      return { ok: true, value: { $oid: s } };
    }
    case "array":
      return { ok: true, value: Array.isArray(raw) ? raw : [] };
    case "object":
      return { ok: true, value: isPlainObject(raw) ? raw : {} };
    default:
      return { ok: false, error: "未対応の型です" };
  }
}

export function formatDisplayValue(value: unknown): string {
  switch (inferType(value)) {
    case "objectId":
      return `ObjectId("${(value as { $oid: string }).$oid}")`;
    case "date":
      return new Date(unwrapValue(value) as number).toISOString();
    case "int32":
      return (value as { $numberInt: string }).$numberInt;
    case "int64":
      return (value as { $numberLong: string }).$numberLong;
    case "string":
      return value as string;
    case "double":
      return String(value);
    case "bool":
      return String(value);
    case "null":
      return "null";
    case "array":
      return `Array(${(value as unknown[]).length})`;
    case "object":
      return `Object(${Object.keys(value as object).length})`;
    default:
      return String(value);
  }
}

const PREVIEW_MAX_ITEMS = 20;
const PREVIEW_MAX_LEN = 300;

function previewLeaf(value: unknown): string {
  switch (inferType(value)) {
    case "objectId":
      return `ObjectId("${(value as { $oid: string }).$oid}")`;
    case "date":
      return `ISODate("${new Date(unwrapValue(value) as number).toISOString()}")`;
    case "string":
      return JSON.stringify(value);
    case "int32":
      return (value as { $numberInt: string }).$numberInt;
    case "int64":
      return (value as { $numberLong: string }).$numberLong;
    case "null":
      return "null";
    default:
      return String(value);
  }
}

function buildJsonPreview(value: unknown): string {
  const type = inferType(value);
  if (type === "array") {
    const arr = value as unknown[];
    if (arr.length === 0) return "[]";
    const shown = arr.slice(0, PREVIEW_MAX_ITEMS).map(buildJsonPreview);
    if (arr.length > PREVIEW_MAX_ITEMS) shown.push(`… (${arr.length})`);
    return `[ ${shown.join(", ")} ]`;
  }
  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const shown = entries.slice(0, PREVIEW_MAX_ITEMS).map(([k, v]) => `${k}: ${buildJsonPreview(v)}`);
    if (entries.length > PREVIEW_MAX_ITEMS) shown.push(`… (${entries.length})`);
    return `{ ${shown.join(", ")} }`;
  }
  return previewLeaf(value);
}

/** object/array値をNoSQLBooster風のコンパクトなJSON文字列にする（Value列でのコンテナ表示用） */
export function formatJsonPreview(value: unknown): string {
  const text = buildJsonPreview(value);
  return text.length > PREVIEW_MAX_LEN ? `${text.slice(0, PREVIEW_MAX_LEN - 1)}…` : text;
}

/** バッジに表示する短いラベル（型を一目で判別できるよう常にテキストで表示） */
export const TYPE_ICON: Record<BsonTypeTag, string> = {
  objectId: "OID",
  string: "STR",
  int32: "I32",
  int64: "I64",
  double: "DBL",
  date: "DATE",
  bool: "BOOL",
  null: "NULL",
  array: "ARR",
  object: "OBJ",
  unknown: "?",
};

export const TYPE_COLOR: Record<BsonTypeTag, string> = {
  objectId: "var(--accent2)",
  string: "var(--green)",
  int32: "var(--accent)",
  int64: "var(--accent)",
  double: "var(--accent)",
  date: "var(--yellow)",
  bool: "var(--orange)",
  null: "var(--text-muted)",
  array: "var(--text-sub)",
  object: "var(--text-sub)",
  unknown: "var(--red)",
};

export const EDITABLE_LEAF_TYPES: BsonTypeTag[] = [
  "objectId",
  "string",
  "int32",
  "int64",
  "double",
  "date",
  "bool",
  "null",
];
