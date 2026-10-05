use crate::commands::bson_json::{
    ext_json_to_bson as json_to_bson, find_all_as_json,
};
use crate::state::AppState;
use bson::{Bson, Document};
use chrono::Utc;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn export_collection(
    state: State<'_, AppState>,
    connection_id: String,
    db_name: String,
    collection_name: String,
) -> Result<String, String> {
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

    let docs = find_all_as_json(&col, &collection_name).await?;

    serde_json::to_string_pretty(&docs).map_err(|e| format!("JSON変換失敗: {e}"))
}

#[tauri::command]
pub async fn import_collection(
    state: State<'_, AppState>,
    connection_id: String,
    db_name: String,
    collection_name: String,
    json_data: String,
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

    let values: Vec<Value> = serde_json::from_str(&json_data)
        .map_err(|e| format!("JSONパース失敗: {e}"))?;

    let mut docs = Vec::new();
    for v in values {
        match json_to_bson(v)? {
            Bson::Document(doc) => docs.push(doc),
            _ => return Err("配列の各要素はオブジェクトである必要があります".to_string()),
        }
    }

    let count = docs.len() as u64;
    if !docs.is_empty() {
        col.insert_many(docs)
            .await
            .map_err(|e| format!("インポート失敗: {e}"))?;
    }
    Ok(count)
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

    let mut collections_map = serde_json::Map::new();
    let mut total_docs: u64 = 0;

    for col_name in col_names.iter().filter(|n| !is_system_collection(n)) {
        let col = db.collection::<Document>(col_name);
        let docs = find_all_as_json(&col, col_name).await?;
        total_docs += docs.len() as u64;
        collections_map.insert(col_name.clone(), Value::Array(docs));
    }

    let dump = serde_json::json!({
        "version": 1,
        "db_name": db_name,
        "dumped_at": Utc::now().to_rfc3339(),
        "collections": Value::Object(collections_map),
    });

    let json = serde_json::to_string_pretty(&dump)
        .map_err(|e| format!("JSON変換失敗: {e}"))?;

    let zip_bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut buf = Vec::new();
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("dump.json", opts)
            .map_err(|e| format!("ZIPエントリ作成失敗: {e}"))?;
        use std::io::Write;
        zip.write_all(json.as_bytes())
            .map_err(|e| format!("ZIP書き込み失敗: {e}"))?;
        zip.finish().map_err(|e| format!("ZIP完成失敗: {e}"))?;
        Ok(buf)
    })
    .await
    .map_err(|e| format!("スレッド実行失敗: {e}"))??;

    tokio::fs::write(&file_path, zip_bytes)
        .await
        .map_err(|e| format!("ファイル書き込み失敗: {e}"))?;

    Ok(DumpStats {
        collections: col_names.len(),
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

    let zip_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("ファイル読み込み失敗: {e}"))?;

    let json_str = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let cursor = std::io::Cursor::new(zip_bytes);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| format!("ZIPオープン失敗: {e}"))?;
        let mut entry = archive
            .by_name("dump.json")
            .map_err(|_| "ZIPに dump.json が含まれていません".to_string())?;
        use std::io::Read;
        let mut s = String::new();
        entry
            .read_to_string(&mut s)
            .map_err(|e| format!("ZIP読み込み失敗: {e}"))?;
        Ok(s)
    })
    .await
    .map_err(|e| format!("スレッド実行失敗: {e}"))??;

    let dump: Value =
        serde_json::from_str(&json_str).map_err(|e| format!("JSONパース失敗: {e}"))?;

    let collections = dump
        .get("collections")
        .and_then(|v| v.as_object())
        .ok_or("ダンプファイルに collections が含まれていません")?;

    let db = client.database(&db_name);
    let mut total_docs: u64 = 0;
    let mut col_count: usize = 0;

    for (col_name, docs_value) in collections {
        // 旧ダンプに含まれる system.profile 等は書き込み不可のためスキップ
        if is_system_collection(col_name) {
            continue;
        }
        let docs_arr = docs_value
            .as_array()
            .ok_or_else(|| format!("コレクション '{col_name}' のデータが不正です"))?;

        let col = db.collection::<Document>(col_name);

        if drop_before {
            col.drop()
                .await
                .map_err(|e| format!("コレクション削除失敗 ({col_name}): {e}"))?;
        }

        let mut bson_docs = Vec::new();
        for v in docs_arr {
            match json_to_bson(v.clone())? {
                Bson::Document(doc) => bson_docs.push(doc),
                _ => {
                    return Err(format!(
                        "コレクション '{col_name}' に不正なドキュメントが含まれています"
                    ))
                }
            }
        }

        if !bson_docs.is_empty() {
            let count = bson_docs.len() as u64;
            col.insert_many(bson_docs)
                .await
                .map_err(|e| format!("インポート失敗 ({col_name}): {e}"))?;
            total_docs += count;
        }
        col_count += 1;
    }

    Ok(DumpStats {
        collections: col_count,
        documents: total_docs,
    })
}
