// src-tauri/src/commands/engine_cmds.rs
//
// Commandes liées aux moteurs externes (UCI, CECP, DXP, Hub).
//
// Le PROTOCOLE (quelles commandes UCI/CECP envoyer, comment interpréter
// "bestmove"/"move", etc.) reste entièrement en JS dans
// app/worker/jb-engines.js (classes UciEngine/CecpEngine/HubEngine).
// Rust ne fait ici que piloter le tube du processus :
//   - engine_spawn  : lance le binaire, retourne un identifiant de process
//   - engine_write  : écrit une ligne sur son stdin
//   - engine_kill   : le termine
//   - is_file       : valide un chemin de binaire (utilisé par engine.js)
//   - save_engine   : persiste la config d'un moteur et notifie le hub
//
// Le flux stdout est poussé en continu vers la fenêtre hub via l'event
// Tauri "engine-line" ({ processId, line }), que worker-bridge.js relaie
// au SharedWorker (controller.engineLine), qui route vers la bonne
// instance ProcessEngine via son registre interne (voir jb-engines.js).

use crate::state::AppState;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// ── Pool de processus moteurs actifs ─────────────────────────────────────────

pub struct EnginePool {
    next_id: Mutex<u64>,
    children: Mutex<HashMap<String, CommandChild>>,
}

impl Default for EnginePool {
    fn default() -> Self {
        Self { next_id: Mutex::new(0), children: Mutex::new(HashMap::new()) }
    }
}

impl EnginePool {
    fn next_process_id(&self) -> String {
        let mut n = self.next_id.lock().unwrap();
        *n += 1;
        format!("engine-{n}")
    }
}

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
    let new_engine = crate::state::Engine {
        id: id.clone(),
        name: engine["name"].as_str().unwrap_or("").to_string(),
        game: engine["game"].as_str().unwrap_or("").to_string(),
        r#type: engine["type"].as_str().unwrap_or("").to_string(),
        binary: engine["binary"].as_str().map(|s| s.to_string()),
        details: engine["details"].as_str().map(|s| s.to_string()),
        label: None,
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
    {
        let engines = state.engines.lock().unwrap();
        let list: Vec<&crate::state::Engine> = engines.iter().collect();
        app.emit_to("main", "updateEngines", &list).map_err(|e| e.to_string())?;
    }
    // TODO Phase 6 : persister via tauri-plugin-store (cf. template_cmds.rs)
    Ok(())
}

/// Lance un moteur externe en sous-processus.
/// Reçoit { binary, args, cwd, initialCommands } depuis
/// jb-engines.js::ProcessEngine._ensureProcess() (via _sendToHub).
/// Retourne { processId } — exactement la forme attendue par
/// `this._processId = resp.processId;` côté JS.
#[tauri::command]
pub async fn engine_spawn(
    app: AppHandle,
    pool: State<'_, EnginePool>,
    binary: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    initial_commands: Option<Vec<String>>,
) -> Result<Value, String> {
    let shell = app.shell();
    let mut cmd = shell.command(&binary).args(args.unwrap_or_default());
    if let Some(dir) = &cwd {
        cmd = cmd.current_dir(dir);
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("engine_spawn: cannot start '{binary}': {e}"))?;

    let process_id = pool.next_process_id();
    pool.children.lock().unwrap().insert(process_id.clone(), child);

    // tauri-plugin-shell découpe déjà le flux par ligne par défaut (raw_out
    // non activé) : chaque CommandEvent::Stdout/Stderr correspond à une ligne
    // complète, pas à un chunk arbitraire — pas besoin de rebufferiser ici.
    {
        let app_handle = app.clone();
        let process_id_for_task = process_id.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes)
                            .trim_end_matches(['\r', '\n'])
                            .to_string();
                        let _ = app_handle.emit_to("main", "engine-line", serde_json::json!({
                            "processId": process_id_for_task,
                            "line": line,
                        }));
                    }
                    CommandEvent::Terminated(payload) => {
                        log::info!("engine process {process_id_for_task} terminated: {payload:?}");
                        break;
                    }
                    CommandEvent::Error(err) => {
                        log::warn!("engine process {process_id_for_task} error: {err}");
                    }
                    _ => {}
                }
            }
        });
    }

    // Commandes initiales (ex: lignes de configuration envoyées avant le
    // premier "go"), écrites directement après le spawn.
    if let Some(initial) = initial_commands {
        let mut children = pool.children.lock().unwrap();
        if let Some(child) = children.get_mut(&process_id) {
            for line in initial {
                let _ = child.write((line + "\n").as_bytes());
            }
        }
    }

    Ok(serde_json::json!({ "processId": process_id }))
}

/// Écrit une ou plusieurs lignes sur le stdin d'un processus moteur.
/// `text` peut contenir plusieurs lignes séparées par '\n' (jb-engines.js
/// envoie souvent plusieurs commandes UCI/CECP d'un coup, déjà jointes).
#[tauri::command]
pub fn engine_write(pool: State<EnginePool>, process_id: String, text: String) -> Result<(), String> {
    let mut children = pool.children.lock().unwrap();
    let child = children
        .get_mut(&process_id)
        .ok_or_else(|| format!("engine_write: no such process '{process_id}'"))?;
    child
        .write(text.as_bytes())
        .map_err(|e| format!("engine_write: write failed: {e}"))
}

/// Termine un processus moteur et libère son entrée dans la pool.
#[tauri::command]
pub fn engine_kill(pool: State<EnginePool>, process_id: String) -> Result<(), String> {
    let mut children = pool.children.lock().unwrap();
    if let Some(child) = children.remove(&process_id) {
        child
            .kill()
            .map_err(|e| format!("engine_kill: kill failed: {e}"))?;
    }
    Ok(())
}
