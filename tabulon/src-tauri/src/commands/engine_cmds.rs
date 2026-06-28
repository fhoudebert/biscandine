// src-tauri/src/commands/engine_cmds.rs
//
// Commandes liées aux moteurs externes (UCI, CECP, DXP, Hub).
// La logique de communication avec les processus moteurs est dans
// app/worker/jb-engines.js (SharedWorker). Le Rust ne fait que :
//   - vérifier qu'un chemin pointe vers un fichier exécutable (is_file)
//   - persister la configuration des moteurs dans le store (save_engine)

use crate::state::AppState;
use serde_json::Value;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

/// Vérifie qu'un chemin pointe vers un fichier existant.
/// Utilisé par engine.js pour valider le champ "binary".
#[tauri::command]
pub fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Persiste la configuration d'un moteur dans le store Tauri
/// et notifie la fenêtre hub de mettre à jour sa liste.
#[tauri::command]
pub fn save_engine(app: AppHandle, state: State<AppState>, engine: Value) -> Result<(), String> {
    let id = engine["id"].as_str().unwrap_or("").to_string();
    let mut new_engine = crate::state::Engine {
        id:      id.clone(),
        name:    engine["name"].as_str().unwrap_or("").to_string(),
        game:    engine["game"].as_str().unwrap_or("").to_string(),
        r#type:  engine["type"].as_str().unwrap_or("").to_string(),
        binary:  engine["binary"].as_str().map(|s| s.to_string()),
        details: engine["details"].as_str().map(|s| s.to_string()),
        label:   None,
    };
    {
        let mut engines = state.engines.lock().unwrap();
        if let Some(existing) = engines.iter_mut().find(|e| e.id == id) {
            *existing = new_engine;
        } else {
            engines.push(new_engine);
        }
    }
    // Notifier la fenêtre hub (qui mettra à jour la liste des moteurs)
    if let Some(win) = app.get_webview_window("main") {
        let engines = state.engines.lock().unwrap();
        let list: Vec<&crate::state::Engine> = engines.iter().collect();
        win.emit("updateEngines", &list).map_err(|e| e.to_string())?;
    }
    // TODO Phase 6 : persister via tauri-plugin-store
    Ok(())
}
