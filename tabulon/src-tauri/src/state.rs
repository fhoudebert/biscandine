// src-tauri/src/state.rs
//
// État partagé Rust. Ne contient PAS la logique de jeu (qui vit dans le
// SharedWorker côté JS, app/worker/match-worker.js) : seulement ce que Rust
// a besoin de savoir pour gérer fenêtres, store et processus annexes.
//
//   - `matches`  : une entrée par partie ouverte, suffisante pour retrouver
//                  la fenêtre play associée et savoir si elle est en pause
//                  (utilisé par exemple par window_cmds::open_window_for_match
//                  et match_cmds::is_paused/pause/match_ended).
//   - `engines`  : configuration des moteurs externes (UCI/CECP/Hub/DXP),
//                  utilisée pour les notifier au hub (updateEngines) et pour
//                  pré-remplir engine.html. La source de vérité long terme
//                  reste le store Tauri (tauri-plugin-store) ; ce vecteur en
//                  mémoire est un cache de lecture rapide.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// Une partie en cours, du point de vue de Rust.
/// Le détail de l'état de jeu (plateau, coups, joueurs, pause) reste dans le
/// SharedWorker — Rust n'a besoin que de l'identité de la fenêtre associée
/// pour pouvoir l'ouvrir/la fermer/la retrouver par son id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Match {
    pub id: u32,
    pub game_name: String,
    /// Dernier instantané connu côté Rust, si utile (ex: reprise après
    /// rechargement). Peut rester `Value::Null` tant que non utilisé.
    pub game_data: Value,
    /// Label de la fenêtre Tauri affichant le plateau ("play-<id>").
    pub window_label: String,
    /// Labels des fenêtres satellites ouvertes (history, clock, moves...),
    /// pour pouvoir les fermer toutes en une fois si besoin.
    pub satellite_labels: Vec<String>,
}

/// Configuration d'un moteur externe (UCI/CECP/Hub/DXP).
/// Sérialisable : renvoyé directement au hub via `win.emit("updateEngines", ...)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engine {
    pub id: String,
    pub name: String,
    pub game: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub binary: Option<String>,
    /// Détails au format YAML brut (args, variant, movePattern...),
    /// interprété côté JS par jb-engines.js — Rust ne le parse pas.
    pub details: Option<String>,
    pub label: Option<String>,
}

/// État partagé de l'application, géré par Tauri (`.manage(AppState::default())`).
#[derive(Default)]
pub struct AppState {
    pub matches: Mutex<HashMap<u32, Match>>,
    pub engines: Mutex<Vec<Engine>>,
}
