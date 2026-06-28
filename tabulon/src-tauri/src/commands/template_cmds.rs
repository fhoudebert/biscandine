// src-tauri/src/commands/template_cmds.rs

use tauri::{AppHandle, State};
use crate::state::AppState;

/// rpc.call("isTemplateNameValid", name)
#[tauri::command]
pub fn is_template_name_valid(name: String) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// rpc.call("saveTemplate", matchId, name)
#[tauri::command]
pub fn save_template(
    app: AppHandle,
    state: State<AppState>,
    match_id: u32,
    name: String,
) -> Result<(), String> {
    // TODO Phase 4 : sérialiser players + view-options + geometry → store
    log::info!("saveTemplate match={match_id} name={name}");
    Ok(())
}

/// rpc.call("playTemplate", templateName)
#[tauri::command]
pub fn play_template(app: AppHandle, template_name: String) -> Result<(), String> {
    // TODO Phase 4 : charger le template depuis le store et ouvrir play window
    log::info!("playTemplate name={template_name}");
    Ok(())
}

/// rpc.call("removeTemplate", templateName)
/// Délègue au worker via hub — le worker met à jour le store et notifie hub.
#[tauri::command]
pub fn remove_template(app: tauri::AppHandle, template_name: String) -> Result<(), String> {
    crate::commands::match_cmds::dispatch_to_worker(
        &app, "removeTemplate", serde_json::json!([template_name])
    )
}
