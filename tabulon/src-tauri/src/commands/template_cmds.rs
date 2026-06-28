// src-tauri/src/commands/template_cmds.rs
//
// Templates de partie (joueurs + horloge + options de vue sauvegardés sous un
// nom). La logique et le stockage vivent entièrement côté SharedWorker
// (controller.isTemplateNameValid / saveTemplate / playTemplate /
// removeTemplate dans match-worker.js, qui lit/écrit le store via le hub) :
// Rust ne fait que relayer via dispatch_to_worker(), comme pour match_cmds.rs.

use crate::commands::match_cmds::dispatch_to_worker;
use serde_json::Value;
use tauri::AppHandle;

/// rpc.call("isTemplateNameValid", name)
/// Délégué au worker car l'unicité du nom ne peut être vérifiée que là où
/// vit la liste des templates existants (le store, lu par le worker).
#[tauri::command]
pub async fn is_template_name_valid(app: AppHandle, name: String) -> Result<bool, String> {
    let result = dispatch_to_worker(&app, "isTemplateNameValid", serde_json::json!([name])).await?;
    Ok(result.as_bool().unwrap_or(false))
}

/// rpc.call("saveTemplate", matchId, name)
#[tauri::command]
pub async fn save_template(app: AppHandle, match_id: u32, name: String) -> Result<Value, String> {
    dispatch_to_worker(&app, "saveTemplate", serde_json::json!([match_id, name])).await
}

/// rpc.call("playTemplate", templateName)
#[tauri::command]
pub async fn play_template(app: AppHandle, template_name: String) -> Result<Value, String> {
    dispatch_to_worker(&app, "playTemplate", serde_json::json!([template_name])).await
}

/// rpc.call("removeTemplate", templateName)
#[tauri::command]
pub async fn remove_template(app: AppHandle, template_name: String) -> Result<Value, String> {
    dispatch_to_worker(&app, "removeTemplate", serde_json::json!([template_name])).await
}
