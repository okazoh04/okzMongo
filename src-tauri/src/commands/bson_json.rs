use bson::serde_helpers::Utf8LossyDeserialization;
use bson::{Bson, Document, RawDocumentBuf};
use serde_json::Value;

/// 不正なUTF-8バイト列を含むドキュメントでも読み込みを継続できるよう、
/// RawDocumentBuf経由で取得し、通常の変換が失敗した場合はUTF-8をロッシー変換する。
pub fn raw_doc_to_document(raw_doc: RawDocumentBuf) -> Result<Document, String> {
    Document::try_from(raw_doc.as_ref())
        .or_else(|_| {
            bson::from_slice::<Utf8LossyDeserialization<Document>>(raw_doc.as_bytes()).map(|w| w.0)
        })
        .map_err(|e| format!("ドキュメント変換失敗: {e}"))
}

/// Extended JSON変換。
/// $oid/$date/$numberInt/$numberLong で型情報を保持し往復可能。
/// Decimal128/Binary/RegExp等は非対応（表示用文字列にフォールバック）。
pub fn bson_to_ext_json(bson: Bson) -> Value {
    match bson {
        Bson::ObjectId(oid) => serde_json::json!({ "$oid": oid.to_hex() }),
        Bson::DateTime(dt) => serde_json::json!({ "$date": dt.timestamp_millis() }),
        Bson::Document(doc) => {
            let map: serde_json::Map<String, Value> = doc
                .into_iter()
                .map(|(k, v)| (k, bson_to_ext_json(v)))
                .collect();
            Value::Object(map)
        }
        Bson::Array(arr) => Value::Array(arr.into_iter().map(bson_to_ext_json).collect()),
        Bson::Boolean(b) => Value::Bool(b),
        Bson::Int32(i) => serde_json::json!({ "$numberInt": i.to_string() }),
        Bson::Int64(i) => serde_json::json!({ "$numberLong": i.to_string() }),
        Bson::Double(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(s) => Value::String(s),
        Bson::Null => Value::Null,
        other => Value::String(format!("{other}")),
    }
}

pub fn ext_json_to_bson(value: Value) -> Result<Bson, String> {
    match value {
        Value::Null => Ok(Bson::Null),
        Value::Bool(b) => Ok(Bson::Boolean(b)),
        // ラップされていない生の数値（後方互換フォールバック）: i64に収まればInt64、それ以外はDouble
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Bson::Int64(i))
            } else if let Some(f) = n.as_f64() {
                Ok(Bson::Double(f))
            } else {
                Err(format!("数値変換失敗: {n}"))
            }
        }
        Value::String(s) => Ok(Bson::String(s)),
        Value::Array(arr) => {
            let bson_arr: Result<Vec<_>, _> = arr.into_iter().map(ext_json_to_bson).collect();
            Ok(Bson::Array(bson_arr?))
        }
        Value::Object(map) => {
            // Extended JSON の $oid / $date / $numberInt / $numberLong を復元
            if map.len() == 1 {
                if let Some(Value::String(oid_str)) = map.get("$oid") {
                    if let Ok(oid) = bson::oid::ObjectId::parse_str(oid_str) {
                        return Ok(Bson::ObjectId(oid));
                    }
                }
                if let Some(date_val) = map.get("$date") {
                    // 新形式 {"$numberLong": "ミリ秒"} と旧形式（数値直値）の両方を受理
                    let millis = date_val.as_i64().or_else(|| {
                        date_val
                            .get("$numberLong")
                            .and_then(Value::as_str)
                            .and_then(|s| s.parse::<i64>().ok())
                    });
                    if let Some(i) = millis {
                        return Ok(Bson::DateTime(bson::DateTime::from_millis(i)));
                    }
                }
                if let Some(Value::String(s)) = map.get("$numberInt") {
                    if let Ok(i) = s.parse::<i32>() {
                        return Ok(Bson::Int32(i));
                    }
                }
                if let Some(Value::String(s)) = map.get("$numberLong") {
                    if let Ok(i) = s.parse::<i64>() {
                        return Ok(Bson::Int64(i));
                    }
                }
            }
            let mut doc = Document::new();
            for (k, v) in map {
                doc.insert(k, ext_json_to_bson(v)?);
            }
            Ok(Bson::Document(doc))
        }
    }
}

pub fn doc_to_ext_json(doc: Document) -> Value {
    bson_to_ext_json(Bson::Document(doc))
}

pub fn ext_json_to_doc(value: Value) -> Result<Document, String> {
    match ext_json_to_bson(value)? {
        Bson::Document(doc) => Ok(doc),
        _ => Err("オブジェクト形式のJSONが必要です".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_object_id() {
        let oid = bson::oid::ObjectId::new();
        let json = bson_to_ext_json(Bson::ObjectId(oid));
        assert_eq!(json, serde_json::json!({ "$oid": oid.to_hex() }));
        assert_eq!(ext_json_to_bson(json).unwrap(), Bson::ObjectId(oid));
    }

    #[test]
    fn round_trip_int32_int64() {
        let j32 = bson_to_ext_json(Bson::Int32(42));
        assert_eq!(j32, serde_json::json!({ "$numberInt": "42" }));
        assert_eq!(ext_json_to_bson(j32).unwrap(), Bson::Int32(42));

        let j64 = bson_to_ext_json(Bson::Int64(9007199254740993));
        assert_eq!(j64, serde_json::json!({ "$numberLong": "9007199254740993" }));
        assert_eq!(ext_json_to_bson(j64).unwrap(), Bson::Int64(9007199254740993));
    }

    #[test]
    fn round_trip_date() {
        let dt = bson::DateTime::from_millis(1700000000000);
        let json = bson_to_ext_json(Bson::DateTime(dt));
        assert_eq!(json, serde_json::json!({ "$date": 1700000000000i64 }));
        assert_eq!(ext_json_to_bson(json).unwrap(), Bson::DateTime(dt));
    }

    #[test]
    fn date_legacy_and_numberlong_forms_both_accepted() {
        let legacy = serde_json::json!({ "$date": 1700000000000i64 });
        let wrapped = serde_json::json!({ "$date": { "$numberLong": "1700000000000" } });
        assert_eq!(ext_json_to_bson(legacy).unwrap(), ext_json_to_bson(wrapped).unwrap());
    }

    #[test]
    fn nested_document_round_trip() {
        let doc = bson::doc! {
            "name": "Alice",
            "age": Bson::Int32(30),
            "tags": Bson::Array(vec![Bson::String("a".into()), Bson::String("b".into())]),
            "nested": bson::doc! { "flag": true, "score": Bson::Double(1.5) },
        };
        let json = doc_to_ext_json(doc.clone());
        let back = ext_json_to_doc(json).unwrap();
        assert_eq!(doc, back);
    }
}
