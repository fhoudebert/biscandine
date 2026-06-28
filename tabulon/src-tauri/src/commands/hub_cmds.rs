// src-tauri/src/commands/hub_cmds.rs
//
// Commandes liées à la fenêtre hub (main.html) :
//   - get_app_info         remplace require('../package.json')
//   - remove_engine
//   - remove_template
//   - load_board_state
//   - book_history_view
//   - notify_user_response  (réponse au pattern notifyUser Promise)
//
// Pattern notifyUser (le seul cas de réponse renderer→main via rpc.listen) :
//
//   Rust                        hub.js
//   ────                        ──────
//   émet "notifyUser" + token   listen("notifyUser", handler)
//                          ←    affiche bannière, attend clic
//   attend sur channel     ←    invoke("notify_user_response", {token, result})
//   résout Future               ferme bannière

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

// ── AppInfo ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AppInfo {
    pub name:     String,
    pub version:  String,
    pub homepage: String,
}

/// Remplace require('../package.json') dans hub.js
#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        name:     app.package_info().name.clone(),
        version:  app.package_info().version.to_string(),
        homepage: "https://github.com/votre-org/tabulon".into(),
    }
}

// ── Engines ───────────────────────────────────────────────────────────────────

/// rpc.call("removeEngine", id)
#[allow(dead_code)]
pub fn remove_engine(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<(), String> {
    {
        let mut engines = state.engines.lock().unwrap();
        engines.retain(|e| e.id != id);
    }
    // Notifier hub pour qu'il rafraîchisse sa liste
    if let Some(win) = app.get_webview_window("main") {
        let engines = state.engines.lock().unwrap();
        let list: Vec<&crate::state::Engine> = engines.iter().collect();
        win.emit("updateEngines", &list).map_err(|e| e.to_string())?;
    }
    // TODO Phase 4 : persister dans le store
    Ok(())
}

// ── Templates ─────────────────────────────────────────────────────────────────

/// rpc.call("removeTemplate", templateName)
#[allow(dead_code)]
pub fn remove_template(
    app: AppHandle,
    template_name: String,
) -> Result<(), String> {
    // TODO Phase 4 : supprimer du store et notifier hub
    log::info!("removeTemplate name={template_name}");
    if let Some(win) = app.get_webview_window("main") {
        win.emit("updateTemplates", serde_json::json!({}))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Board state ───────────────────────────────────────────────────────────────

/// rpc.call("loadBoardState", gameName, matchId, fen)
#[allow(dead_code)]
pub fn load_board_state(
    app: AppHandle,
    game_name: String,
    match_id: u32,
    fen: String,
) -> Result<(), String> {
    // TODO Phase 4 : charger la position FEN dans le match et émettre vers play
    log::info!("loadBoardState game={game_name} match={match_id} fen={fen}");
    Ok(())
}

// ── Book history ──────────────────────────────────────────────────────────────

/// rpc.call("bookHistoryView", matchId, spec)
#[allow(dead_code)]
pub fn book_history_view(
    app: AppHandle,
    match_id: u32,
    spec: Value,
) -> Result<(), String> {
    // TODO Phase 4 : interpréter le spec et émettre vers play window
    log::info!("bookHistoryView match={match_id} spec={spec}");
    Ok(())
}

// ── notifyUser Promise pattern ────────────────────────────────────────────────
//
// Problème : hub.js fait rpc.listen({ notifyUser: fn }) où fn retourne une
// Promise. L'ancien rpc.js attendait cette Promise avant d'envoyer la réponse
// au main. Dans Tauri, les events sont fire-and-forget. On simule le pattern
// avec un token + channel oneshot stocké dans un état global.

pub struct NotifyChannels {
    pub pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl Default for NotifyChannels {
    fn default() -> Self {
        Self { pending: Mutex::new(HashMap::new()) }
    }
}

/// Appelé par le Rust interne pour déclencher une notification hub
/// et attendre la réponse utilisateur.
/// Émet l'event "notifyUser" + token vers la fenêtre main,
/// puis attend sur un channel oneshot.
pub async fn push_notify_user(
    app: &AppHandle,
    channels: &NotifyChannels,
    text: &str,
    ok_text: &str,
    ko_text: &str,
) -> bool {
    let token = format!("notify-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());

    let (tx, rx) = oneshot::channel::<bool>();
    {
        let mut pending = channels.pending.lock().unwrap();
        pending.insert(token.clone(), tx);
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("notifyUser", serde_json::json!({
            "token":   token,
            "text":    text,
            "okText":  ok_text,
            "koText":  ko_text
        }));
    }

    rx.await.unwrap_or(false)
}

/// invoke("notify_user_response", { token, result })
/// Appelé par hub.js quand l'utilisateur clique OK ou Annuler.
#[tauri::command]
pub fn notify_user_response(
    channels: State<NotifyChannels>,
    token: String,
    result: bool,
) -> Result<(), String> {
    let mut pending = channels.pending.lock().unwrap();
    if let Some(tx) = pending.remove(&token) {
        let _ = tx.send(result);
    }
    Ok(())
}
