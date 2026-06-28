# Tabulon

Application de bureau multiplateforme pour jouer aux jeux de plateau, basée sur **Tauri 2** + la bibliothèque JavaScript **Jocly**.

Migration de [JoclyBoard](https://github.com/mi-g/joclyboard) (Electron) vers Tauri.

---

## État du projet

**Migration structurelle complète.** Toute la base de code Electron a été portée. Le projet compile et la structure est prête pour les tests d'intégration et les travaux de finalisation.

---

## Architecture

```
tabulon/
├── package.json              # Scripts racine (tauri dev/build, gulp)
├── gulpfile.mjs              # Compilation parser PJN (Gulp 5, ES modules)
│
├── app/                      # Frontend HTML/JS
│   ├── package.json          # Dépendances frontend
│   ├── PJNParser.js          # Parser PJN généré par Gulp/Jison
│   │
│   ├── core/                 # ★ Cœur métier JS (équivalent du main process Electron)
│   │   ├── tabulon-core.js   # Couche d'abstraction : invoke, store, fenêtres, events
│   │   ├── jb-match.js       # Classe JBMatch : cycle de vie d'une partie
│   │   └── jb-controller.js  # Contrôleur : orchestre matchs, templates, engines, favoris
│   │
│   └── content/              # Pages HTML + JS des fenêtres
│       ├── tabulon-rpc.js    # ★ Remplace rpc.js  (invoke + listen Tauri)
│       ├── tabulon-winutils.js # ★ Remplace joclyboard-winutils.js
│       ├── tabulon.css       # ★ Remplace photonkit CSS
│       ├── hub.html/js       # Fenêtre principale (liste des jeux, nav)
│       ├── play.html/js      # Plateau de jeu (WebGL/Jocly)
│       ├── game.html/js      # Fiche d'un jeu (info, lancement)
│       ├── players.html/js   # Configuration des joueurs A/B
│       ├── view-options.html/js  # Options visuelles (skin, sons…)
│       ├── history.html/js   # Historique des coups
│       ├── clock.html/js     # Horloge de jeu
│       ├── clock-setup.html/js   # Configuration de l'horloge
│       ├── moves.html/js     # Liste des coups possibles
│       ├── engine.html/js    # Configuration des moteurs externes
│       ├── camera-view.html/js   # Points de vue 3D
│       ├── info.html/js      # Règles / crédits / à propos
│       ├── book.html/js      # Chargement de livres PGN/PDN/PJN
│       ├── book-history.html/js  # Visualisation des parties d'un livre
│       ├── save-template.html/js # Sauvegarde de templates de configuration
│       ├── show-position.html/js # Affichage de l'état du plateau (FEN)
│       ├── open-position.html/js # Saisie d'une position FEN
│       └── save-template.html/js
│
└── src-tauri/                # Backend Rust
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/
        ├── main.rs           # Point d'entrée desktop
        ├── lib.rs            # Builder Tauri + 64 commandes enregistrées
        ├── state.rs          # AppState partagé (matches, engines, favorites)
        ├── window_manager.rs # open_window() + persistance géométrie + updater
        └── commands/
            ├── mod.rs
            ├── match_cmds.rs   # 32 thin wrappers → contrôleur JS
            ├── window_cmds.rs  # 17 ouvertures de fenêtres secondaires
            ├── hub_cmds.rs     # get_app_info, notify_user_response (pattern oneshot)
            ├── engine_cmds.rs  # is_file, save_engine, engine_get_move, kill_match_engines
            ├── template_cmds.rs # 4 commandes templates
            ├── video_cmds.rs   # start/stop/record_frame → ffmpeg pipe stdin
            └── fs_cmds.rs      # read_text_file, parse_pjn
```

---

## Architecture des communications

Le pattern central remplace `ipcMain`/`ipcRenderer` d'Electron :

```
Renderer (play.js, history.js…)
  └─► tRpc.call('command', args)
        └─► Tauri invoke()
              └─► Rust commande
                    └─► emit('controller-call', { method, args, token })
                          └─► hub.js startControllerListener()
                                └─► jb-controller.js ctrl.method(args)
                                      └─► tCore.emit(targetLabel, event, payload)
                                            └─► invoke('relay_to_window', { target, event, payload:{payload,token2} })
                                                  └─► Rust win.emit(event)
                                                        └─► Renderer tRpc.listen({ event: handler })
                                                              └─► emit('rpc-reply:token2', { result })
                                                                    └─► tCore.emit() résout ✓
```

---

## Table de correspondance Electron → Tauri

| Electron (JoclyBoard) | Tabulon (Tauri) |
|---|---|
| `ipcMain` / `ipcRenderer` via `rpc.js` | `invoke()` + `emit()`/`listen()` via `tabulon-rpc.js` |
| `remote.getCurrentWebContents().emit()` | `emit('window-ready', { label })` via `tabulon-winutils.js` |
| `electron-store` | `@tauri-apps/plugin-store` |
| `electron.shell.openExternal(url)` | `open(url)` de `@tauri-apps/plugin-shell` |
| `electron.dialog.showSaveDialog` | `@tauri-apps/plugin-dialog` |
| `electron-updater` | `tauri-plugin-updater` |
| `process.argv` | `tauri-plugin-cli` |
| `os.platform()` | `@tauri-apps/plugin-os` |
| `window.close()` | `getCurrentWindow().close()` |
| `BrowserWindow` + `createWindow()` | `WebviewWindow` via `window_manager.rs` |
| `require('../package.json')` | commande Rust `get_app_info` |
| `photonkit` CSS | `tabulon.css` (custom, mêmes classes HTML) |
| `ffmpeg-stream` + `mp4-mjpeg` | `video_cmds.rs` → spawn ffmpeg pipe stdin |
| XHR vers `file://` (`info.js`) | commande Rust `read_text_file` |
| `PJNParser` côté hub | commande Rust `parse_pjn` |
| Main process (Node.js) | `app/core/` (JS dans WebView hub) |

---

## Plugins Tauri utilisés

| Plugin | Remplace |
|---|---|
| `tauri-plugin-store` | `electron-store` |
| `tauri-plugin-shell` | `child_process.spawn` + `shell.openExternal` |
| `tauri-plugin-dialog` | `electron.dialog` |
| `tauri-plugin-os` | `os.platform()` |
| `tauri-plugin-fs` | accès `file://` |
| `tauri-plugin-updater` | `electron-updater` |
| `tauri-plugin-cli` | `process.argv` |

---

## Commandes Tauri (64 au total)

### match_cmds (32) — thin wrappers vers jb-controller.js
`new_match`, `new_clocked_match`, `clone_match`, `load_match`, `take_back`, `restart`, `pause`, `is_paused`, `replay_last_move`, `get_history`, `freeze`, `get_players_info`, `set_players`, `get_clock`, `get_view_info`, `set_view_options`, `is_favorite`, `set_favorite`, `input_move`, `show_move`, `get_camera`, `set_camera`, `book_history_view`, `load_board_state`, `show_board_state`, `open_window_for_match`, `match_ended`, `close_window`, `open_book_window`, `open_show_position`, `show_error_dialog`, `notify_user`

### window_cmds (17) — ouverture des fenêtres secondaires
`open_history`, `open_clock`, `open_players`, `open_view_options`, `open_camera_view`, `open_save_template`, `open_info`, `open_board_state`, `open_book`, `open_book_match`, `open_moves`, `open_game`, `edit_engine`, `open_book_history`, `open_position`, `relay_to_window`, `open_board_state_dialog`

### engine_cmds (4)
`is_file`, `save_engine`, `engine_get_move`, `kill_match_engines`

### hub_cmds (2)
`get_app_info`, `notify_user_response`

### template_cmds (4)
`is_template_name_valid`, `save_template`, `play_template`, `remove_template`

### video_cmds (3)
`start_recording`, `stop_recording`, `record_frame`

### fs_cmds (2)
`read_text_file`, `parse_pjn`

---

## Installation et démarrage

### Prérequis

```bash
# Rust + Cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri CLI
cargo install tauri-cli --version "^2"

# Node.js ≥ 20

# ffmpeg (pour l'enregistrement vidéo)
# Linux : apt install ffmpeg
# macOS : brew install ffmpeg
# Windows : winget install ffmpeg
```

### Démarrage

```bash
# 1. Installer les dépendances racine
npm install

# 2. Installer les dépendances frontend
npm --prefix app install

# 3. Compiler le parser PJN (si pjn-parser/*.jison existe)
npm run build:parser

# 4. Lancer en mode développement
npm run dev
# ou
cargo tauri dev
```

### Build production

```bash
npm run build
# Produit dans : src-tauri/target/release/bundle/
```

---

## Travaux restants

### Priorité haute
- [ ] **Tests d'intégration** — premier `cargo tauri dev` et corriger les erreurs runtime
- [ ] **Moteurs externes** — implémenter `engine_get_move` dans `engine_cmds.rs` (UCI/CECP/Hub via `tauri-plugin-shell` sidecar)
- [ ] **Persistance des engines/templates/favoris** — connecter au store Tauri dans `engine_cmds.rs`, `template_cmds.rs` (tous les `// TODO Phase 6`)
- [ ] **show_error_dialog** — connecter à `tauri-plugin-dialog` (actuellement log uniquement)

### Priorité moyenne
- [ ] **Fairy-Stockfish WebAssembly** — intégration de `fairy-stockfish-nnue.wasm` ou `ffish-es6` pour le jeu contre l'ordinateur sans moteur externe
- [ ] **Updater** — configurer la clé publique et l'endpoint dans `tauri.conf.json`
- [ ] **Icons** — générer les icônes dans `src-tauri/icons/`
- [ ] **DXP engine** — port TCP via `tauri-plugin-net` (actuellement stub)

### Priorité basse
- [ ] **Tests automatisés** — unit tests Rust pour `parse_pjn`, `video_cmds`, `window_manager`
- [ ] **Packaging** — tester les builds Linux/Win/macOS
- [ ] **tabulon.css** — compléter les icônes Entypo manquantes (codes `\e022` et suivants)

---

## Particularités notables

### Le cœur métier reste en JavaScript
`app/core/jb-match.js` + `jb-controller.js` tournent dans la WebView hub. La bibliothèque Jocly étant une lib JS browser, la porter en Rust aurait signifié réécrire le moteur de jeux entier. Le Rust ne fait que gérer fenêtres, store, processus externes et vidéo.

### Pattern notifyUser
Seul cas de réponse renderer→main via `rpc.listen` dans JoclyBoard. Implémenté avec `tokio::sync::oneshot` dans `hub_cmds.rs` : Rust émet `notifyUser` + token vers hub, hub affiche la bannière, l'utilisateur clique, hub appelle `notify_user_response(token, result)`, Rust résout la Future.

### PJNParser dans book-history.html
`PJNParser.js` est généré par Gulp/Jison en format CommonJS. `book-history.html` inclut un shim CJS minimal (3 balises `<script>`) pour l'exposer comme `window.PJNParser` avant l'import ES module de `book-history.js`.

### Enregistrement vidéo
`video_cmds.rs` spawn ffmpeg avec `stdin: piped`. Les frames JPEG arrivent via `record_frame()`, sont décodées depuis le data-URI base64 et écrites directement sur le stdin de ffmpeg (`-f mjpeg -r 30`). `stop_recording()` ferme stdin → ffmpeg finalise le MP4.
