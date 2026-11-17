// JSON を書く場所（クエリパッド・フィルタ・ドキュメント編集）で共通に使う、
// mongosh 風の JavaScript 式の評価と整形。キーの "" を省略でき、ObjectId(...) 等も書ける。
import { inferType } from "./bsonTypes";
import type { Messages } from "../i18n";

/** 値が空（undefined など）で JSON にできないときのエラー。表示時に翻訳する */
export class ExprEmptyError extends Error {
  constructor() {
    super("Value is empty");
    this.name = "ExprEmptyError";
  }
}

// mongosh でよく使われるコンストラクタを Extended JSON 形式へ変換するスタブ。
// バックエンド（bson_json.rs）が対応する $oid/$date/$numberInt/$numberLong のみ実装。
// `new Date()` とも書けるよう、アロー関数ではなく function で定義する。
const MONGO_SHELL_GLOBALS = {
  ObjectId: function (id?: string) { return { $oid: id ?? "000000000000000000000000" }; },
  ISODate: function (s?: string) { return { $date: s ? new Date(s).getTime() : Date.now() }; },
  Date: function (s?: string) { return { $date: s ? new Date(s).getTime() : Date.now() }; },
  NumberLong: function (v: string | number) { return { $numberLong: String(v) }; },
  NumberInt: function (v: string | number) { return { $numberInt: String(v) }; },
};

// 式の文字列を実際に JS として評価する（mongosh 同様、裸キーや ObjectId(...) 等をサポート）。
// 評価コンテキストは webview の JS 実行環境そのものなので、任意コード実行のリスクは
// 「ユーザーが自分で打ち込んだクエリをその場で実行する」という mongosh と同じ信頼境界。
export function evalMongoExpr(src: string): unknown {
  const names = Object.keys(MONGO_SHELL_GLOBALS);
  const fn = new Function(...names, `"use strict"; return (${src});`);
  return fn(...names.map(n => (MONGO_SHELL_GLOBALS as Record<string, unknown>)[n]));
}

/** 式を評価し、JSON として表現できる値（undefined・関数などを除去済み）で返す */
export function parseMongoExpr(src: string): unknown {
  const json = JSON.stringify(evalMongoExpr(src));
  if (json === undefined) throw new ExprEmptyError();
  return JSON.parse(json);
}

/** 式を評価して Extended JSON 文字列にする。空なら fallback をそのまま返す */
export function mongoExprToJson(src: string, fallback: string): string {
  const s = src.trim();
  if (!s) return fallback;
  return JSON.stringify(parseMongoExpr(s));
}

/** 評価エラーを表示用の文字列にする。t を渡すと、既知のエラーを翻訳した文言にする */
export function exprErrorMessage(e: unknown, t?: Messages): string {
  if (t && e instanceof ExprEmptyError) return t.exprEmpty;
  return e instanceof Error ? e.message : String(e);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function formatKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

function formatDate(value: { $date: unknown }): string | null {
  const d = value.$date;
  let ms: number;
  if (typeof d === "number") ms = d;
  else if (typeof d === "string") ms = new Date(d).getTime();
  else if (d && typeof d === "object" && typeof (d as { $numberLong?: unknown }).$numberLong === "string") {
    ms = Number((d as { $numberLong: string }).$numberLong);
  } else return null;
  if (!Number.isFinite(ms)) return null;
  return `ISODate(${JSON.stringify(new Date(ms).toISOString())})`;
}

/**
 * 値を mongosh 風の JavaScript 式に整形する（evalMongoExpr で元に戻せる形）。
 * キーは識別子として書けるものは "" を付けず、Extended JSON は ObjectId(...) 等で表す。
 */
export function formatMongoExpr(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  switch (inferType(value)) {
    case "objectId":
      return `ObjectId(${JSON.stringify((value as { $oid: string }).$oid)})`;
    case "date": {
      const s = formatDate(value as { $date: unknown });
      if (s) return s;
      break;
    }
    case "int32":
      return `NumberInt(${(value as { $numberInt: string }).$numberInt})`;
    case "int64":
      return `NumberLong(${JSON.stringify((value as { $numberLong: string }).$numberLong)})`;
    case "array": {
      const arr = value as unknown[];
      if (arr.length === 0) return "[]";
      return `[\n${arr.map(v => inner + formatMongoExpr(v, indent + 1)).join(",\n")}\n${pad}]`;
    }
    case "null":
      return "null";
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{\n${entries
      .map(([k, v]) => `${inner}${formatKey(k)}: ${formatMongoExpr(v, indent + 1)}`)
      .join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value) ?? "null";
}
