// src-tauri/src/commands/match_cmds.rs
//
// Thin wrappers Tauri → contrôleur JS (jb-controller.js).
//
// Architecture : le contrôleur tourne dans la WebView "main" (hub.html).
// Chaque invoke() d'un renderer est relayé via l'event Tauri "controller-call"
// avec { method, args, token }. Le contrôleur répond via "controller-reply:<token>".
// dispatch_to_controller() attend cette réponse et la retourne au renderer.

use crate::state::AppState;
use crate::window_manager::{open_window, WindowOptions};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Émet "controller-call" vers le hub et attend "controller-reply:<token>".
pub fn dispatch_to_controller(app: &AppHandle, method: &str, args: Value) -> Result<(), String> {
    let token = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed).to_string();
    let win   = app.get_webview_window("main").ok_or("Hub window not found")?;
    win.emit("controller-call", serde_json::json!({
        "method": method,
        "args":   args,
        "token":  token,
    })).map_err(|e| e.to_string())
}

/// Version async qui attend la réponse du contrôleur.
pub async fn dispatch_and_await(app: &AppHandle, method: &str, args: Value) -> Result<Value, String> {
    let token   = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed).to_string();
    let reply_event = format!("controller-reply:{}", token);

    let (tx, rx) = oneshot::channel::<Result<Value, String>>();
    let tx       = std::sync::Mutex::new(Some(tx));

    let _unlisten = app.listen(reply_event.clone(), move |event| {
        let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
        if let Some(tx) = tx.lock().unwrap().take() {
            if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
                let _ = tx.send(Err(err.to_string()));
            } else {
                let _ = tx.send(Ok(payload["result"].clone()));
            }
        }
    });

    let win = app.get_webview_window("main").ok_or("Hub window not found")?;
    win.emit("controller-call", serde_json::json!({
        "method": method,
        "args":   args,
        "token":  token,
    })).map_err(|e| e.to_string())?;

    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        rx,
    ).await
        .map_err(|_| format!("controller call '{method}' timed out"))?
        .map_err(|_| "controller channel closed".to_string())?
}

// ── Commandes fire-and-forget (délèguent sans attendre de retour) ─────────────

#[tauri::command]
pub fn new_match(app: AppHandle, game_name: String, clock: Option<Value>) -> Result<(), String> {
    dispatch_to_controller(&app, "newMatch", serde_json::json!([game_name, clock]))
}

#[tauri::command]
pub fn new_clocked_match(app: AppHandle, game_name: String) -> Result<(), String> {
    dispatch_to_controller(&app, "newClockedMatch", serde_json::json!([game_name]))
}

#[tauri::command]
pub fn clone_match(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "cloneMatch", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn load_match(app: AppHandle, match_id: u32, data: Value) -> Result<(), String> {
    dispatch_to_controller(&app, "loadMatch", serde_json::json!([match_id, data]))
}

#[tauri::command]
pub fn take_back(app: AppHandle, match_id: u32, to_index: Option<u32>) -> Result<(), String> {
    dispatch_to_controller(&app, "takeBack", serde_json::json!([match_id, to_index]))
}

#[tauri::command]
pub fn restart(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "restart", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn pause(app: AppHandle, state: State<AppState>, match_id: u32, paused: bool) -> Result<(), String> {
    {
        let mut matches = state.matches.lock().unwrap();
        if let Some(m) = matches.get_mut(&match_id) { m.paused = paused; }
    }
    dispatch_to_controller(&app, "pause", serde_json::json!([match_id, paused]))
}

#[tauri::command]
pub fn is_paused(state: State<AppState>, match_id: u32) -> Result<bool, String> {
    Ok(state.matches.lock().unwrap().get(&match_id).map(|m| m.paused).unwrap_or(false))
}

#[tauri::command]
pub fn replay_last_move(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "replayLastMove", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn get_history(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "getHistory", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn freeze(app: AppHandle, match_id: u32, index: i32, animate: Option<bool>) -> Result<(), String> {
    dispatch_to_controller(&app, "freeze", serde_json::json!([match_id, index, animate]))
}

#[tauri::command]
pub fn get_players_info(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "getPlayersInfo", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn set_players(app: AppHandle, match_id: u32, players: Value) -> Result<(), String> {
    dispatch_to_controller(&app, "setPlayers", serde_json::json!([match_id, players]))
}

#[tauri::command]
pub fn get_clock(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "getClock", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn get_view_info(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "getViewInfo", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn set_view_options(app: AppHandle, match_id: u32, options: Value) -> Result<(), String> {
    dispatch_to_controller(&app, "setViewOptions", serde_json::json!([match_id, options]))
}

#[tauri::command]
pub fn is_favorite(app: AppHandle, game_name: String) -> Result<(), String> {
    dispatch_to_controller(&app, "isFavorite", serde_json::json!([game_name]))
}

#[tauri::command]
pub fn set_favorite(app: AppHandle, game_name: String, value: bool) -> Result<(), String> {
    dispatch_to_controller(&app, "setFavorite", serde_json::json!([game_name, value]))
}

#[tauri::command]
pub fn input_move(app: AppHandle, match_id: u32, r#move: Value) -> Result<(), String> {
    dispatch_to_controller(&app, "inputMove", serde_json::json!([match_id, r#move]))
}

#[tauri::command]
pub fn show_move(app: AppHandle, match_id: u32, r#move: Option<Value>) -> Result<(), String> {
    dispatch_to_controller(&app, "showMove", serde_json::json!([match_id, r#move]))
}

#[tauri::command]
pub fn get_camera(app: AppHandle, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "getCamera", serde_json::json!([match_id]))
}

#[tauri::command]
pub fn set_camera(app: AppHandle, match_id: u32, details: Value) -> Result<(), String> {
    dispatch_to_controller(&app, "setCamera", serde_json::json!([match_id, details]))
}

#[tauri::command]
pub fn book_history_view(app: AppHandle, match_id: u32, spec: Value) -> Result<(), String> {
    dispatch_to_controller(&app, "bookHistoryView", serde_json::json!([match_id, spec]))
}

#[tauri::command]
pub fn load_board_state(app: AppHandle, game_name: String, match_id: u32, fen: String) -> Result<(), String> {
    dispatch_to_controller(&app, "loadBoardState", serde_json::json!([game_name, match_id, fen]))
}

#[tauri::command]
pub fn show_board_state(app: AppHandle, game_name: String, match_id: u32) -> Result<(), String> {
    dispatch_to_controller(&app, "showBoardState", serde_json::json!([game_name, match_id]))
}

// ── Utilitaires utilisés par worker-bridge (maintenant par jb-controller.js) ──

/// Ouvre une fenêtre play ou clock-setup depuis le contrôleur
#[tauri::command]
pub fn open_window_for_match(
    app:         AppHandle,
    state:       State<AppState>,
    r#type:      String,
    game_name:   Option<String>,
    match_id:    Option<u32>,
    view_options: Option<Value>,
) -> Result<(), String> {
    let id = match_id.unwrap_or(0);
    let gn = game_name.as_deref().unwrap_or("");
    match r#type.as_str() {
        "play" => {
            {
                let mut matches = state.matches.lock().unwrap();
                matches.insert(id, crate::state::Match {
                    id, game_name: gn.to_string(), paused: false,
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
            }).map_err(|e| e.to_string())
        }
        "clock-setup" => open_window(&app, WindowOptions {
            label: &format!("clock-setup-{gn}"),
            url:   &format!("content/clock-setup.html?game={gn}"),
            title: &format!("{gn} clock setup"),
            width: 360.0, height: 480.0,
            min_width: 280.0, min_height: 300.0,
            persist_key: None,
        }).map_err(|e| e.to_string()),
        _ => Err(format!("Unknown window type: {}", r#type))
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
        url:   &format!("content/book.html?game={game_name}&file={}", urlencoding::encode(&file_name)),
        title: &format!("{game_name} Book"),
        width: 300.0, height: 450.0, min_width: 200.0, min_height: 250.0,
        persist_key: Some(format!("window:book-{game_name}")),
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_show_position(app: AppHandle, game_name: String, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("board-state-{game_name}-{match_id}"),
        url:   &format!("content/show-position.html?game={game_name}&id={match_id}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 180.0, min_width: 280.0, min_height: 120.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_error_dialog(app: AppHandle, title: String, message: String) -> Result<(), String> {
    log::error!("[Dialog] {title}: {message}");
    Ok(())
}

#[tauri::command]
pub fn notify_user(_app: AppHandle, request: crate::commands::hub_cmds::NotifyRequest) -> Result<bool, String> {
    log::info!("notify_user: {}", request.text);
    Ok(false)
}
