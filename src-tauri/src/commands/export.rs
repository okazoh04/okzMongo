use crate::commands::bson_json::{
    doc_to_ext_json, ext_json_to_bson as json_to_bson, raw_doc_to_document,
};
use crate::state::AppState;
use bson::{Bson, Document, RawDocumentBuf};
use chrono::Utc;
use futures_util::TryStreamExt;
use mongodb::Collection;
use serde::de::{DeserializeSeed, Error as _, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserializer as _;
use serde_json::Value;
use std::fmt;
use std::io::{BufReader, BufWriter, Write};
use tauri::State;

const BATCH_SIZE: usize = 1000;

fn io_err(e: std::io::Error) -> String {
    format!("ファイル書き込み失敗: {e}")
}

/// 1件ずつ JSON として書き出す（全件を保持しない）
fn write_json<W: Write, T: serde::Serialize>(w: &mut W, v: &T) -> Result<(), String> {
    serde_json::to_writer(&mut *w, v).map_err(|e| format!("JSON書き込み失敗: {e}"))
}

#[tauri::command]
pub async fn export_collection(
    state: State<'_, AppState>,
    connection_id: String,
    db_name: String,
    collection_name: String,
    file_path: String,
) -> Result<u64, String> {
    let client = state
        .active_clients
        .lock()
        .unwrap()
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| format!("接続 '{connection_id}' が見つかりません"))?;

    let col = client
        .database(&db_name)
        .collection::<RawDocumentBuf>(&collection_name);
    let mut cursor = col
        .find(Document::new())
        .await
        .map_err(|e| format!("find失敗 ({collection_name}): {e}"))?;

    // 1件ずつ読んで順にファイルへ書き出す（全件をメモリに載せない）
    let file = std::fs::File::create(&file_path)
        .map_err(|e| format!("ファイル作成失敗: {e}"))?;
    let mut w = BufWriter::new(file);
    w.write_all(b"[\n").map_err(io_err)?;
    let mut n: u64 = 0;
    while let Some(raw) = cursor
        .try_next()
        .await
        .map_err(|e| format!("カーソル読み込み失敗 ({collection_name}): {e}"))?
    {
        if n > 0 {
            w.write_all(b",\n").map_err(io_err)?;
        }
        write_json(&mut w, &doc_to_ext_json(raw_doc_to_document(raw)?))?;
        n += 1;
    }
    w.write_all(b"\n]\n").map_err(io_err)?;
    w.flush().map_err(io_err)?;
    Ok(n)
}

#[tauri::command]
pub async fn import_collection(
    state: State<'_, AppState>,
    connection_id: String,
    db_name: String,
    collection_name: String,
    file_path: String,
) -> Result<u64, String> {
    let client = state
        .active_clients
        .lock()
        .unwrap()
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| format!("接続 '{connection_id}' が見つかりません"))?;

    let col = client
        .database(&db_name)
        .collection::<Document>(&collection_name);

    // ファイルを読みながら BATCH_SIZE 件ごとに挿入する（全件を保持しない）
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let file = std::fs::File::open(&file_path)
            .map_err(|e| format!("ファイル読み込み失敗: {e}"))?;
        let mut de = serde_json::Deserializer::from_reader(BufReader::new(file));
        let n = InsertSeq { handle: &handle, col: &col }
            .deserialize(&mut de)
            .map_err(|e| format!("JSONパース失敗: {e}"))?;
        de.end().map_err(|e| format!("JSONパース失敗: {e}"))?;
        Ok(n)
    })
    .await
    .map_err(|e| format!("スレッド実行失敗: {e}"))?
}

/// 挿入ヘルパー：Vec<Document> を BATCH_SIZE 件ずつ insert_many する
fn flush_batch(
    handle: &tokio::runtime::Handle,
    col: &Collection<Document>,
    batch: &mut Vec<Document>,
) -> Result<u64, String> {
    let docs = std::mem::take(batch);
    let n = docs.len() as u64;
    handle
        .block_on(async { col.insert_many(docs).await })
        .map_err(|e| format!("インポート失敗: {e}"))?;
    Ok(n)
}

/// JSON配列を1要素ずつ読みながら挿入する（spawn_blocking 内で block_on して非同期 insert を呼ぶ）
struct InsertSeq<'a> {
    handle: &'a tokio::runtime::Handle,
    col: &'a Collection<Document>,
}

impl<'de, 'a> DeserializeSeed<'de> for InsertSeq<'a> {
    type Value = u64;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<u64, D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de, 'a> Visitor<'de> for InsertSeq<'a> {
    type Value = u64;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("ドキュメントの配列")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<u64, A::Error> {
        let mut batch: Vec<Document> = Vec::with_capacity(BATCH_SIZE);
        let mut count: u64 = 0;
        while let Some(v) = seq.next_element::<Value>()? {
            match json_to_bson(v).map_err(|e| A::Error::custom(e))? {
                Bson::Document(doc) => batch.push(doc),
                _ => {
                    return Err(A::Error::custom(
                        "配列の各要素はオブジェクトである必要があります",
                    ))
                }
            }
            if batch.len() >= BATCH_SIZE {
                count += flush_batch(self.handle, self.col, &mut batch)
                    .map_err(|e| A::Error::custom(e))?;
            }
        }
        if !batch.is_empty() {
            count += flush_batch(self.handle, self.col, &mut batch)
                .map_err(|e| A::Error::custom(e))?;
        }
        Ok(count)
    }
}

#[derive(serde::Serialize)]
pub struct DumpStats {
    pub collections: usize,
    pub documents: u64,
}

/// `system.profile` 等のサーバー管理コレクション（ユーザーによる書き込み不可）
fn is_system_collection(name: &str) -> bool {
    name.starts_with("system.")
}

#[tauri::command]
pub async fn dump_database(
    state: State<'_, AppState>,
    connection_id: String,
    db_name: String,
    file_path: String,
) -> Result<DumpStats, String> {
    let client = state
        .active_clients
        .lock()
        .unwrap()
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| format!("接続 '{connection_id}' が見つかりません"))?;

    let db = client.database(&db_name);
    let col_names = db
        .list_collection_names()
        .await
        .map_err(|e| format!("コレクションリスト取得失敗: {e}"))?;

    // ZIP の dump.json エントリへ、コレクションごとに1件ずつ書き出す（全件を保持しない）
    let file = std::fs::File::create(&file_path)
        .map_err(|e| format!("ファイル作成失敗: {e}"))?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(file));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("dump.json", opts)
        .map_err(|e| format!("ZIPエントリ作成失敗: {e}"))?;

    zip.write_all(b"{\"version\":1,\"db_name\":").map_err(io_err)?;
    write_json(&mut zip, &db_name)?;
    zip.write_all(b",\"dumped_at\":").map_err(io_err)?;
    write_json(&mut zip, &Utc::now().to_rfc3339())?;
    zip.write_all(b",\"collections\":{").map_err(io_err)?;

    let mut total_docs: u64 = 0;
    let mut col_count: usize = 0;
    for col_name in col_names.iter().filter(|n| !is_system_collection(n)) {
        if col_count > 0 {
            zip.write_all(b",").map_err(io_err)?;
        }
        write_json(&mut zip, col_name)?;
        zip.write_all(b":[").map_err(io_err)?;

        let col = db.collection::<RawDocumentBuf>(col_name);
        let mut cursor = col
            .find(Document::new())
            .await
            .map_err(|e| format!("find失敗 ({col_name}): {e}"))?;
        let mut n: u64 = 0;
        while let Some(raw) = cursor
            .try_next()
            .await
            .map_err(|e| format!("カーソル読み込み失敗 ({col_name}): {e}"))?
        {
            if n > 0 {
                zip.write_all(b",").map_err(io_err)?;
            }
            write_json(&mut zip, &doc_to_ext_json(raw_doc_to_document(raw)?))?;
            n += 1;
        }
        zip.write_all(b"]").map_err(io_err)?;
        total_docs += n;
        col_count += 1;
    }
    zip.write_all(b"}}").map_err(io_err)?;

    let writer = zip.finish().map_err(|e| format!("ZIP完成失敗: {e}"))?;
    writer
        .into_inner()
        .map_err(|e| format!("ファイル書き込み失敗: {}", e.error()))?;

    Ok(DumpStats {
        collections: col_count,
        documents: total_docs,
    })
}

#[tauri::command]
pub async fn restore_database(
    state: State<'_, AppState>,
    connection_id: String,
    db_name: String,
    file_path: String,
    drop_before: bool,
) -> Result<DumpStats, String> {
    let client = state
        .active_clients
        .lock()
        .unwrap()
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| format!("接続 '{connection_id}' が見つかりません"))?;

    let db = client.database(&db_name);
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || restore_blocking(handle, db, file_path, drop_before))
        .await
        .map_err(|e| format!("スレッド実行失敗: {e}"))?
}

/// ZIP内の dump.json をストリーミングで読み、コレクションごとに BATCH_SIZE 件ずつ挿入する
fn restore_blocking(
    handle: tokio::runtime::Handle,
    db: mongodb::Database,
    file_path: String,
    drop_before: bool,
) -> Result<DumpStats, String> {
    let file = std::fs::File::open(&file_path)
        .map_err(|e| format!("ファイル読み込み失敗: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("ZIPオープン失敗: {e}"))?;
    let entry = archive
        .by_name("dump.json")
        .map_err(|_| "ZIPに dump.json が含まれていません".to_string())?;

    let ctx = Ctx { handle: &handle, db: &db, drop_before };
    let mut totals = Totals::default();
    let mut de = serde_json::Deserializer::from_reader(BufReader::new(entry));
    (&mut de)
        .deserialize_map(DumpVisitor { ctx: &ctx, totals: &mut totals })
        .map_err(|e| format!("JSONパース失敗: {e}"))?;
    de.end().map_err(|e| format!("JSONパース失敗: {e}"))?;

    if !totals.has_collections {
        return Err("ダンプファイルに collections が含まれていません".to_string());
    }
    Ok(DumpStats {
        collections: totals.cols,
        documents: totals.docs,
    })
}

struct Ctx<'a> {
    handle: &'a tokio::runtime::Handle,
    db: &'a mongodb::Database,
    drop_before: bool,
}

#[derive(Default)]
struct Totals {
    docs: u64,
    cols: usize,
    has_collections: bool,
}

/// ダンプのトップレベルオブジェクト（"collections" 以外のキーは読み飛ばす）
struct DumpVisitor<'a> {
    ctx: &'a Ctx<'a>,
    totals: &'a mut Totals,
}

impl<'de, 'a> Visitor<'de> for DumpVisitor<'a> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("ダンプのオブジェクト")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        while let Some(key) = map.next_key::<String>()? {
            if key == "collections" {
                self.totals.has_collections = true;
                map.next_value_seed(CollectionsSeed {
                    ctx: self.ctx,
                    totals: &mut *self.totals,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}

/// "collections" のオブジェクト：コレクション名 → ドキュメント配列
struct CollectionsSeed<'a> {
    ctx: &'a Ctx<'a>,
    totals: &'a mut Totals,
}

impl<'de, 'a> DeserializeSeed<'de> for CollectionsSeed<'a> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de, 'a> Visitor<'de> for CollectionsSeed<'a> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("コレクションのオブジェクト")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        while let Some(name) = map.next_key::<String>()? {
            // 旧ダンプに含まれる system.profile 等は書き込み不可のためスキップ
            if is_system_collection(&name) {
                map.next_value::<IgnoredAny>()?;
                continue;
            }
            let col = self.ctx.db.collection::<Document>(&name);
            if self.ctx.drop_before {
                self.ctx
                    .handle
                    .block_on(async { col.drop().await })
                    .map_err(|e| M::Error::custom(format!("コレクション削除失敗 ({name}): {e}")))?;
            }
            let n = map.next_value_seed(InsertSeq {
                handle: self.ctx.handle,
                col: &col,
            })?;
            self.totals.docs += n;
            self.totals.cols += 1;
        }
        Ok(())
    }
}
