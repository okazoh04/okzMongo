use crate::commands::bson_json::{ext_json_to_doc, raw_doc_to_document};
use crate::state::AppState;
use bson::{oid::ObjectId, Document, RawDocumentBuf};
use futures_util::TryStreamExt;
use mongodb::error::{ErrorKind, InsertManyError};
use mongodb::IndexModel;
use serde_json::Value;
use tauri::State;

const BATCH_SIZE: usize = 1000;
const DUPLICATE_KEY_CODE: i32 = 11000;

#[derive(serde::Serialize)]
pub struct CopyStats {
    pub copied: u64,
    pub skipped: u64,
    pub indexes: u64,
}

fn get_client(state: &AppState, connection_id: &str) -> Result<mongodb::Client, String> {
    state
        .active_clients
        .lock()
        .unwrap()
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("接続 '{connection_id}' が見つかりません"))
}

/// バッチ挿入し、_id重複で弾かれた件数を返す（それ以外のエラーは失敗扱い）
async fn insert_batch(
    col: &mongodb::Collection<RawDocumentBuf>,
    batch: Vec<RawDocumentBuf>,
) -> Result<u64, String> {
    let size = batch.len() as u64;
    match col.insert_many(batch).ordered(false).await {
        Ok(_) => Ok(0),
        Err(e) => match *e.kind {
            ErrorKind::InsertMany(InsertManyError {
                write_errors: Some(ref errs),
                write_concern_error: None,
                ..
            }) if !errs.is_empty() && errs.iter().all(|w| w.code == DUPLICATE_KEY_CODE) => {
                Ok((errs.len() as u64).min(size))
            }
            _ => Err(format!("貼り付け失敗: {e}")),
        },
    }
}

/// ソースのコレクション（filter_json 条件）を、別コレクション/別DB/別接続へ複製する。
/// BSON をそのまま（Raw のまま）転送するため Decimal128/Binary 等も欠落しない。
#[tauri::command]
pub async fn copy_documents(
    state: State<'_, AppState>,
    src_connection_id: String,
    src_db: String,
    src_collection: String,
    filter_json: String,
    dst_connection_id: String,
    dst_db: String,
    dst_collection: String,
    regenerate_ids: bool,
    copy_indexes: bool,
) -> Result<CopyStats, String> {
    let src_client = get_client(&state, &src_connection_id)?;
    let dst_client = get_client(&state, &dst_connection_id)?;

    let src_col = src_client
        .database(&src_db)
        .collection::<RawDocumentBuf>(&src_collection);
    let dst_col = dst_client
        .database(&dst_db)
        .collection::<RawDocumentBuf>(&dst_collection);

    let filter: Document = if filter_json.trim().is_empty() || filter_json.trim() == "{}" {
        Document::new()
    } else {
        let v: Value = serde_json::from_str(&filter_json)
            .map_err(|e| format!("フィルタJSONパース失敗: {e}"))?;
        ext_json_to_doc(v)?
    };

    let mut cursor = src_col
        .find(filter)
        .await
        .map_err(|e| format!("find失敗: {e}"))?;

    let mut stats = CopyStats { copied: 0, skipped: 0, indexes: 0 };
    let mut batch: Vec<RawDocumentBuf> = Vec::with_capacity(BATCH_SIZE);

    while let Some(raw) = cursor
        .try_next()
        .await
        .map_err(|e| format!("カーソル読み込み失敗: {e}"))?
    {
        let raw = if regenerate_ids {
            let mut doc = raw_doc_to_document(raw)?;
            doc.insert("_id", ObjectId::new());
            RawDocumentBuf::from_document(&doc)
                .map_err(|e| format!("ドキュメント変換失敗: {e}"))?
        } else {
            raw
        };
        batch.push(raw);
        if batch.len() >= BATCH_SIZE {
            let n = batch.len() as u64;
            let skipped = insert_batch(&dst_col, std::mem::take(&mut batch)).await?;
            stats.copied += n - skipped;
            stats.skipped += skipped;
        }
    }
    if !batch.is_empty() {
        let n = batch.len() as u64;
        let skipped = insert_batch(&dst_col, batch).await?;
        stats.copied += n - skipped;
        stats.skipped += skipped;
    }

    if copy_indexes {
        stats.indexes = copy_index_definitions(&src_col, &dst_col).await;
    }
    Ok(stats)
}

/// `_id_` 以外のインデックス定義を複製する（失敗しても全体は成功扱い、作成できた件数を返す）
async fn copy_index_definitions(
    src: &mongodb::Collection<RawDocumentBuf>,
    dst: &mongodb::Collection<RawDocumentBuf>,
) -> u64 {
    let Ok(cursor) = src.list_indexes().await else { return 0 };
    let Ok(models) = cursor.try_collect::<Vec<IndexModel>>().await else { return 0 };
    let mut created = 0;
    for model in models {
        let is_id = model
            .options
            .as_ref()
            .and_then(|o| o.name.as_deref())
            .map_or(false, |n| n == "_id_");
        if is_id {
            continue;
        }
        if dst.create_index(model).await.is_ok() {
            created += 1;
        }
    }
    created
}
