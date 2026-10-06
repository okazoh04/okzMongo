mod commands;
mod connect_error;
mod crypto;
mod query_log;
mod ssh_tunnel;
mod state;

use commands::{connection::*, copy::*, database::*, export::*};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .setup(|app| {
            let key = init_key(app.handle());
            let saved = load_connections(app.handle(), &key);
            let state = app.state::<AppState>();
            state.crypto_key.set(key).ok();
            state.connections.lock().unwrap().extend(saved);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 接続管理
            list_connections,
            add_connection,
            update_connection,
            remove_connection,
            connect,
            disconnect,
            list_connected_ids,
            test_connection,
            // DB操作
            list_databases,
            list_collections,
            find_documents,
            count_documents,
            insert_document,
            update_document,
            delete_document,
            drop_collection,
            create_collection,
            // インポート/エクスポート
            export_collection,
            import_collection,
            dump_database,
            restore_database,
            // コピー&ペースト
            copy_documents,
            // クエリスクラッチパッド
            run_aggregate,
            get_field_names,
            delete_one_by_filter,
            update_one_by_filter,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri アプリケーションの起動に失敗しました");
}
