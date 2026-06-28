// src-tauri/src/commands/window_cmds.rs
//
// Remplace les appels rpc.call("openXxx", matchId) depuis les renderers.
// Chaque commande ouvre (ou focus) la fenêtre secondaire correspondante.

use crate::window_manager::{open_window, WindowOptions};
use tauri::{AppHandle, Manager, WebviewWindow};
use serde_json::Value;
// urlencoding est déjà une dépendance transitive de Tauri

// ── Helpers ───────────────────────────────────────────────────────────────────

fn play_window(app: &AppHandle, match_id: u32) -> Option<WebviewWindow> {
    app.get_webview_window(&format!("play-{match_id}"))
}

// ── Commandes d'ouverture ─────────────────────────────────────────────────────

/// rpc.call("openHistory", matchId)
#[tauri::command]
pub fn open_history(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("history-{match_id}"),
        url:   &format!("content/history.html?id={match_id}"),
        title: &format!("History #{match_id}"),
        width: 400.0, height: 500.0,
        min_width: 280.0, min_height: 200.0,
        persist_key: Some(format!("window:history-{match_id}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("openClock", matchId)
#[tauri::command]
pub fn open_clock(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("clock-{match_id}"),
        url:   &format!("content/clock.html?id={match_id}"),
        title: &format!("Clock #{match_id}"),
        width: 400.0, height: 220.0,
        min_width: 200.0, min_height: 100.0,
        persist_key: Some(format!("window:clock-{match_id}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("openPlayers", matchId)
#[tauri::command]
pub fn open_players(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("players-{match_id}"),
        url:   &format!("content/players.html?id={match_id}"),
        title: &format!("Players #{match_id}"),
        width: 460.0, height: 300.0,
        min_width: 300.0, min_height: 200.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

/// rpc.call("openViewOptions", matchId)
#[tauri::command]
pub fn open_view_options(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("view-options-{match_id}"),
        url:   &format!("content/view-options.html?id={match_id}"),
        title: &format!("View Options #{match_id}"),
        width: 360.0, height: 400.0,
        min_width: 260.0, min_height: 200.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

/// rpc.call("openCameraView", matchId)
#[tauri::command]
pub fn open_camera_view(app: AppHandle, match_id: u32, game_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("camera-{match_id}"),
        url:   &format!("content/camera-view.html?id={match_id}&game={game_name}"),
        title: &format!("Camera View #{match_id}"),
        width: 340.0, height: 500.0,
        min_width: 260.0, min_height: 300.0,
        persist_key: Some(format!("window:camera-{match_id}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("openSaveTemplate", matchId)
#[tauri::command]
pub fn open_save_template(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("save-template-{match_id}"),
        url:   &format!("content/save-template.html?id={match_id}"),
        title: &format!("Save template #{match_id}"),
        width: 360.0, height: 240.0,
        min_width: 260.0, min_height: 180.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

/// rpc.call("openInfo", gameName)
#[tauri::command]
pub fn open_info(app: AppHandle, game_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("info-{game_name}"),
        url:   &format!("content/info.html?game={game_name}"),
        title: &format!("About {game_name}"),
        width: 600.0, height: 500.0,
        min_width: 400.0, min_height: 300.0,
        persist_key: Some(format!("window:info-{game_name}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("openBoardState", gameName, matchId?)
#[tauri::command]
pub fn open_board_state(app: AppHandle, game_name: String, match_id: Option<u32>) -> Result<(), String> {
    let id_str = match_id.map(|i| i.to_string()).unwrap_or_default();
    let label = format!("board-state-{game_name}-{id_str}");
    open_window(&app, WindowOptions {
        label: &label,
        url:   &format!("content/show-position.html?game={game_name}&id={id_str}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 300.0,
        min_width: 280.0, min_height: 180.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

/// rpc.call("openBook", gameName, fileName, data)
#[tauri::command]
pub fn open_book(app: AppHandle, game_name: String, file_name: String, _data: String) -> Result<(), String> {
    // TODO Phase 4 : parser le PGN/PDN/PJN et stocker dans AppState avant d'ouvrir
    let label = format!("book-{game_name}");
    open_window(&app, WindowOptions {
        label: &label,
        url:   &format!("content/book.html?game={game_name}&file={file_name}"),
        title: &format!("{game_name} Book"),
        width: 400.0, height: 500.0,
        min_width: 280.0, min_height: 300.0,
        persist_key: Some(format!("window:book-{game_name}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("openBookMatch", gameName, match)
#[tauri::command]
pub fn open_book_match(app: AppHandle, game_name: String, book_match: Value) -> Result<(), String> {
    // Récupère le matchId courant depuis AppState si nécessaire
    // TODO Phase 4 : charger la partie du livre dans un nouveau match
    log::info!("openBookMatch game={game_name} match={book_match}");
    Ok(())
}

/// rpc.call("openMoves", matchId)
#[tauri::command]
pub fn open_moves(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("moves-{match_id}"),
        url:   &format!("content/moves.html?id={match_id}"),
        title: &format!("Possible moves #{match_id}"),
        width: 240.0, height: 400.0,
        min_width: 180.0, min_height: 200.0,
        persist_key: Some(format!("window:moves-{match_id}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("showBoardState", gameName, matchId)
#[tauri::command]
pub fn show_board_state(app: AppHandle, game_name: String, match_id: u32) -> Result<(), String> {
    // TODO Phase 4 : récupérer la position FEN/PJN depuis AppState et l'émettre
    if let Some(win) = app.get_webview_window(&format!("board-state-{game_name}-{match_id}")) {
        win.emit("setPosition", "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// rpc.call("openGame", gameName)  →  ouvre la fiche d'un jeu (game.html)
#[tauri::command]
pub fn open_game(app: AppHandle, game_name: String) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("game-{game_name}"),
        url:   &format!("content/game.html?game={game_name}"),
        title: &game_name,
        width: 700.0, height: 500.0,
        min_width: 400.0, min_height: 300.0,
        persist_key: Some(format!("window:game-{game_name}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("editEngine", id?)  →  ouvre engine.html (création ou édition)
#[tauri::command]
pub fn edit_engine(app: AppHandle, state: tauri::State<crate::state::AppState>, id: Option<String>) -> Result<(), String> {
    let engine_json = if let Some(ref eid) = id {
        let engines = state.engines.lock().unwrap();
        engines.iter()
            .find(|e| &e.id == eid)
            .map(|e| serde_json::to_string(e).unwrap_or_default())
            .unwrap_or_default()
    } else {
        // Nouvel engine : générer un id unique
        let new_id = format!("engine-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        serde_json::json!({ "id": new_id, "name": "", "game": "", "type": "" }).to_string()
    };
    let encoded = urlencoding::encode(&engine_json).to_string();
    let label = id.as_deref().unwrap_or("new");
    open_window(&app, WindowOptions {
        label: &format!("engine-{label}"),
        url:   &format!("content/engine.html?engine={encoded}"),
        title: if id.is_some() { "Edit engine" } else { "New engine" },
        width: 400.0, height: 420.0,
        min_width: 300.0, min_height: 300.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

/// Ouvre book-history.html pour visualiser un PJN chargé
#[tauri::command]
pub fn open_book_history(app: AppHandle, match_id: u32) -> Result<(), String> {
    open_window(&app, WindowOptions {
        label: &format!("book-history-{match_id}"),
        url:   &format!("content/book-history.html?id={match_id}"),
        title: &format!("Book #{match_id}"),
        width: 500.0, height: 600.0,
        min_width: 300.0, min_height: 300.0,
        persist_key: Some(format!("window:book-history-{match_id}")),
    }).map_err(|e| e.to_string())
}

/// rpc.call("openBoardState", gameName, matchId)  →  open-position.html (saisie FEN)
#[tauri::command]
pub fn open_position(app: AppHandle, game_name: String, match_id: Option<u32>) -> Result<(), String> {
    let id_str = match_id.map(|i| i.to_string()).unwrap_or_default();
    open_window(&app, WindowOptions {
        label: &format!("open-position-{game_name}"),
        url:   &format!("content/open-position.html?game={game_name}&id={id_str}"),
        title: &format!("{game_name} board state"),
        width: 400.0, height: 240.0,
        min_width: 280.0, min_height: 180.0,
        persist_key: None,
    }).map_err(|e| e.to_string())
}

// ── Relay RPC (push Rust → renderer cible) ───────────────────────────────────
//
// Remplace rpc.call(window, "method", ...args) du main Electron.
// Appelé par le main Rust quand il veut pousser un événement vers
// un renderer spécifique (ex: humanTurn → fenêtre play-<id>).

/// relay_to_window("play-1", "humanTurn", payload)
#[tauri::command]
pub fn relay_to_window(
    app: AppHandle,
    target: String,   // label de la fenêtre cible
    event: String,    // nom de l'événement Tauri
    payload: Value,   // données à transmettre
) -> Result<(), String> {
    let win = app.get_webview_window(&target)
        .ok_or_else(|| format!("Window '{target}' not found"))?;
    win.emit(&event, payload).map_err(|e| e.to_string())
}
