// src-tauri/src/commands/match_cmds.rs
//
// Thin wrappers Tauri → SharedWorker JS (app/worker/match-worker.js).
//
// Architecture : tout le métier de jeu tourne dans un SharedWorker, relayé
// par la fenêtre hub ("main") via worker-bridge.js. Chaque invoke() d'un
// renderer émet l'event Tauri "dispatch-to-worker" avec { method, args, token }
// vers cette fenêtre ; un petit listener dans hub.js appelle
// bridge.call(method, ...args) puis répond via "worker-reply:<token>".
// dispatch_to_worker() attend cette réponse et la retourne au renderer —
// contrairement à l'ancien mécanisme, qui ignorait systématiquement la valeur
// renvoyée, alors que plusieurs renderers (players.js, clock.js, view-options.js,
// history.js, game.js, play.js…) en ont réellement besoin.

use crate::state::AppState;
use crate::window_manager::{open_window, WindowOptions};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::oneshot;

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Émet "dispatch-to-worker" vers le hub et attend "worker-reply:<token>".
/// Timeout de 30s pour éviter de bloquer indéfiniment un renderer si le hub
/// ou le worker ne répond jamais (worker planté, requête mal formée...).
pub async fn dispatch_to_worker(app: &AppHandle, method: &str, args: Value) -> Result<Value, String> {
    // Vérifié explicitement : emit_to() est silencieux si la fenêtre cible
    // n'existe pas (elle ne lève pas d'erreur), donc sans ce contrôle on
    // attendrait le timeout complet de 30s avant d'échouer.
    if app.get_webview_window("main").is_none() {
        return Err("Hub window not found".to_string());
    }

    let token = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed).to_string();
    let reply_event = format!("worker-reply:{token}");

    let (tx, rx) = oneshot::channel::<Result<Value, String>>();
    let tx = std::sync::Mutex::new(Some(tx));

    let unlisten_id = app.listen(reply_event.clone(), move |event| {
        let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
        if let Some(tx) = tx.lock().unwrap().take() {
            if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
                let _ = tx.send(Err(err.to_string()));
            } else {
                let _ = tx.send(Ok(payload["result"].clone()));
            }
        }
    });

    app.emit_to("main", "dispatch-to-worker", serde_json::json!({
        "method": method,
        "args": args,
        "token": token,
    })).map_err(|e| e.to_string())?;

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| format!("worker call '{method}' timed out"))?
        .map_err(|_| "worker reply channel closed".to_string())?;

    app.unlisten(unlisten_id);
    result
}

// ── Cycle de vie d'une partie ──────────────────────────────────────────────────

#[tauri::command]
pub async fn new_match(app: AppHandle, game_name: String, clock: Option<Value>) -> Result<Value, String> {
    dispatch_to_worker(&app, "newMatch", serde_json::json!([game_name, clock])).await
}

#[tauri::command]
pub async fn new_clocked_match(app: AppHandle, game_name: String) -> Result<Value, String> {
    dispatch_to_worker(&app, "newClockedMatch", serde_json::json!([game_name])).await
}

#[tauri::command]
pub async fn clone_match(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "cloneMatch", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn load_match(app: AppHandle, match_id: u32, data: Value) -> Result<Value, String> {
    dispatch_to_worker(&app, "loadMatch", serde_json::json!([match_id, data])).await
}

#[tauri::command]
pub async fn take_back(app: AppHandle, match_id: u32, to_index: Option<u32>) -> Result<Value, String> {
    dispatch_to_worker(&app, "takeBack", serde_json::json!([match_id, to_index])).await
}

#[tauri::command]
pub async fn restart(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "restart", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn pause(app: AppHandle, match_id: u32, paused: bool) -> Result<Value, String> {
    dispatch_to_worker(&app, "pause", serde_json::json!([match_id, paused])).await
}

/// Lecture d'état pure ; déléguée au worker (seule source de vérité sur la
/// pause d'un match), pas dupliquée côté Rust pour éviter toute désync.
#[tauri::command]
pub async fn is_paused(app: AppHandle, match_id: u32) -> Result<bool, String> {
    let result = dispatch_to_worker(&app, "isPaused", serde_json::json!([match_id])).await?;
    Ok(result.as_bool().unwrap_or(false))
}

#[tauri::command]
pub async fn replay_last_move(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "replayLastMove", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn get_history(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "getHistory", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn freeze(app: AppHandle, match_id: u32, index: i32, animate: Option<bool>) -> Result<Value, String> {
    dispatch_to_worker(&app, "freeze", serde_json::json!([match_id, index, animate])).await
}

#[tauri::command]
pub async fn get_players_info(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "getPlayersInfo", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn set_players(app: AppHandle, match_id: u32, players: Value) -> Result<Value, String> {
    dispatch_to_worker(&app, "setPlayers", serde_json::json!([match_id, players])).await
}

#[tauri::command]
pub async fn get_clock(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "getClock", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn get_view_info(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "getViewInfo", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn set_view_options(app: AppHandle, match_id: u32, options: Value) -> Result<Value, String> {
    dispatch_to_worker(&app, "setViewOptions", serde_json::json!([match_id, options])).await
}

#[tauri::command]
pub async fn is_favorite(app: AppHandle, game_name: String) -> Result<bool, String> {
    let result = dispatch_to_worker(&app, "isFavorite", serde_json::json!([game_name])).await?;
    Ok(result.as_bool().unwrap_or(false))
}

#[tauri::command]
pub async fn set_favorite(app: AppHandle, game_name: String, value: bool) -> Result<Value, String> {
    dispatch_to_worker(&app, "setFavorite", serde_json::json!([game_name, value])).await
}

#[tauri::command]
pub async fn input_move(app: AppHandle, match_id: u32, r#move: Value) -> Result<Value, String> {
    dispatch_to_worker(&app, "inputMove", serde_json::json!([match_id, r#move])).await
}

#[tauri::command]
pub async fn show_move(app: AppHandle, match_id: u32, r#move: Option<Value>) -> Result<Value, String> {
    dispatch_to_worker(&app, "showMove", serde_json::json!([match_id, r#move])).await
}

#[tauri::command]
pub async fn get_camera(app: AppHandle, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "getCamera", serde_json::json!([match_id])).await
}

#[tauri::command]
pub async fn set_camera(app: AppHandle, match_id: u32, details: Value) -> Result<Value, String> {
    dispatch_to_worker(&app, "setCamera", serde_json::json!([match_id, details])).await
}

#[tauri::command]
pub async fn book_history_view(app: AppHandle, match_id: u32, spec: Value) -> Result<Value, String> {
    dispatch_to_worker(&app, "bookHistoryView", serde_json::json!([match_id, spec])).await
}

#[tauri::command]
pub async fn load_board_state(app: AppHandle, game_name: String, match_id: u32, fen: String) -> Result<Value, String> {
    dispatch_to_worker(&app, "loadBoardState", serde_json::json!([game_name, match_id, fen])).await
}

#[tauri::command]
pub async fn show_board_state(app: AppHandle, game_name: String, match_id: u32) -> Result<Value, String> {
    dispatch_to_worker(&app, "showBoardState", serde_json::json!([game_name, match_id])).await
}

/// rpc.call("removeEngine", id) — délègue à controller.removeEngine côté worker.
/// (hub.js appelle cette commande quand l'utilisateur supprime un moteur
/// depuis la liste du hub.)
#[tauri::command]
pub async fn remove_engine(app: AppHandle, id: String) -> Result<Value, String> {
    dispatch_to_worker(&app, "removeEngine", serde_json::json!([id])).await
}

// ── Fenêtres et relais (purement Rust, pas de délégation au worker) ──────────

/// Ouvre une fenêtre play ou clock-setup. Appelée par worker-bridge.js en
/// réponse à l'event "open-window" émis par le worker (voir handleWorkerEvent).
#[tauri::command]
pub fn open_window_for_match(
    app: AppHandle,
    state: State<AppState>,
    r#type: String,
    game_name: Option<String>,
    match_id: Option<u32>,
    view_options: Option<Value>,
) -> Result<(), String> {
    let id = match_id.unwrap_or(0);
    let gn = game_name.as_deref().unwrap_or("");
    match r#type.as_str() {
        "play" => {
            {
                let mut matches = state.matches.lock().unwrap();
                matches.insert(id, crate::state::Match {
                    id, game_name: gn.to_string(),
                    game_data: Value::Null,
                    window_label: format!("play-{id}"),
                    satellite_labels: vec![],
                });
            }
            let opts_str = view_options
                .map(|o| serde_json::to_string(&o).unwrap_or_default())
                .unwrap_or_default();
            let url = if opts_str.is_empty() {
                format!("content/play.html?game={gn}&id={id}")
            } else {
                format!("content/play.html?game={gn}&id={id}&options={}", urlencoding::encode(&opts_str))
            };
            open_window(&app, WindowOptions {
                label: &format!("play-{id}"), url: &url,
                title: &format!("{gn} #{id}"),
                width: 700.0, height: 630.0,
                min_width: 400.0, min_height: 400.0,
                persist_key: Some(format!("window:play-{gn}")),
            }).map(|_| ()).map_err(|e| e.to_string())
        }
        "clock-setup" => open_window(&app, WindowOptions {
            label: &format!("clock-setup-{gn}"),
            url: &format!("content/clock-setup.html?game={gn}"),
            title: &format!("{gn} clock setup"),
            width: 360.0, height: 480.0,
            min_width: 280.0, min_height: 300.0,
            persist_key: None,
        }).map(|_| ()).map_err(|e| e.to_string()),
        _ => Err(format!("Unknown window type: {}", r#type)),
    }
}

#[tauri::command]
pub fn match_ended(state: State<AppState>, match_id: u32) -> Result<(), String> {
    state.matches.lock().unwrap().remove(&match_id);
    Ok(())
}

#[tauri::command]
pub fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_book_window(app: AppHandle, game_name: String, file_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("book-{game_name}"),
        url: &format!("content/book.html?game={game_name}&file={}", urlencoding::encode(&file_name)),
        title: &format!("{game_name} Book"),
        width: 300.0, height: 450.0, min_width: 200.0, min_height: 250.0,
        persist_key: Some(format!("window:book-{game_name}")),
    }).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_show_position(app: AppHandle, game_name: String, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("board-state-{game_name}-{match_id}"),
        url: &format!("content/show-position.html?game={game_name}&id={match_id}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 180.0, min_width: 280.0, min_height: 120.0,
        persist_key: None,
    }).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_error_dialog(app: AppHandle, title: String, message: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    log::error!("[Dialog] {title}: {message}");
    app.dialog().message(message).title(title).blocking_show();
    Ok(())
}

/// Affiche une bannière de confirmation dans le hub et attend la réponse de
/// l'utilisateur (pattern oneshot, voir hub_cmds::push_notify_user).
#[tauri::command]
pub async fn notify_user(
    app: AppHandle,
    channels: State<'_, crate::commands::hub_cmds::NotifyChannels>,
    request: crate::commands::hub_cmds::NotifyRequest,
) -> Result<bool, String> {
    let ok = crate::commands::hub_cmds::push_notify_user(
        &app,
        &channels,
        &request.text,
        request.ok_text.as_deref().unwrap_or("OK"),
        request.ko_text.as_deref().unwrap_or("Cancel"),
    ).await;
    Ok(ok)
}
