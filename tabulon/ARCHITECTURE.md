# Tabulon — Architecture

Internal architecture notes for Tabulon. For installation and build commands, see [README.md](./README.md).

Application de bureau multiplateforme pour jouer aux jeux de plateau, basée sur **Tauri 2** + la bibliothèque JavaScript **Jocly**.

Migration de [JoclyBoard](https://github.com/mi-g/joclyboard) (Electron) vers Tauri.

---

## État du projet

**Migration structurelle en cours — non fonctionnelle en l'état.**

Le dépôt contient deux tentatives d'implémentation du cœur métier :

- une architecture **legacy** (`app/content/tabulon-core.js`, `app/worker/jb-match.js`, `app/worker/jb-controller.js`), proche du Electron d'origine ;
- une architecture **SharedWorker** (`app/worker/match-worker.js`, `app/worker/worker-bridge.js`, `app/worker/jb-engines.js`), plus récente.

**Décision actée : on conserve l'architecture SharedWorker.** Elle a l'implémentation la plus aboutie des protocoles moteurs externes (UCI/CECP/Hub déjà écrits en JS dans `jb-engines.js`), et correspond mieux à un modèle Tauri idiomatique (un seul "cerveau" applicatif, des fenêtres qui ne sont que des vues). L'architecture legacy doit être considérée comme du code mort à supprimer au fil des sessions suivantes.

Ce document décrit l'architecture **cible** (SharedWorker) telle qu'elle doit fonctionner une fois les travaux de finalisation terminés — voir la section [Travaux restants](#travaux-restants) pour l'écart avec l'état actuel du code.

---

## Architecture

```
tabulon/
├── package.json              # Scripts racine (tauri dev/build, gulp)
├── gulpfile.js                # Compilation parser PJN (Gulp 5)
│
├── dist/                       # Build de jocly2 (gulp build), copié tel quel — voir Installation
│
├── app/                       # Frontend HTML/JS
│   ├── package.json           # Dépendances frontend (@tauri-apps/*, jquery, js-yaml, photonkit)
│   ├── PJNParser.js            # Parser PJN généré par Gulp/Jison
│   │
│   ├── worker/                 # ★ Cœur métier — tourne dans un SharedWorker
│   │   ├── match-worker.js     # JBMatch + controller : tout le métier Jocly
│   │   ├── worker-bridge.js    # Connecteur hub.js ↔ SharedWorker ↔ events Tauri
│   │   └── jb-engines.js       # Moteurs externes : UCI / CECP / Hub / DXP
│   │
│   └── content/                 # Pages HTML + JS des fenêtres (vues pures)
│       ├── tabulon-rpc.js       # invoke()/listen() Tauri génériques
│       ├── tabulon-winutils.js  # Titre de fenêtre + signal "window-ready"
│       ├── tabulon.css          # Feuille de style custom (remplace photonkit)
│       ├── hub.html/js          # Fenêtre principale — instancie le SharedWorker
│       ├── play.html/js         # Plateau de jeu (WebGL/Jocly) — piloté par le worker
│       └── [15 autres fenêtres satellites : history, clock, players, moves, …]
│
└── src-tauri/                  # Backend Rust — gère ce qui n'est pas du métier de jeu
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/
        ├── main.rs
        ├── lib.rs               # Builder Tauri + commandes enregistrées
        ├── state.rs             # AppState partagé (matches, engines, processus moteurs)
        ├── window_manager.rs    # open_window() + persistance géométrie + updater
        └── commands/
            ├── mod.rs
            ├── match_cmds.rs    # Relais renderer → worker (invoke/réponse via worker-bridge)
            ├── window_cmds.rs   # Ouverture de fenêtres secondaires + relay_to_window
            ├── hub_cmds.rs      # get_app_info, notify_user (pattern oneshot)
            ├── engine_cmds.rs   # Primitives bas niveau process moteurs (spawn/write/kill)
            ├── template_cmds.rs # Persistance templates (délègue au worker)
            ├── video_cmds.rs    # start/stop/record_frame → ffmpeg pipe stdin
            └── fs_cmds.rs       # read_text_file, parse_pjn
```

---

## Qui fait quoi : Rust vs SharedWorker

### Le Rust gère ce qui touche au système / à l'OS

Rust ne contient **aucune logique de jeu**. Jocly est une bibliothèque JS navigateur ; la porter en Rust signifierait réécrire le moteur de jeux entier. Le Rust se limite à :

- **Cycle de vie des fenêtres** (`window_manager.rs`) — ouverture, focus, fermeture, persistance de géométrie, relais d'événements (`relay_to_window`).
- **Store** (`tauri-plugin-store`) — persistance clé-valeur (engines, templates, favoris, options de vue). Le worker n'a pas d'accès disque direct ; il demande au hub de lire/écrire via le store, qui relaie à Rust.
- **CLI args** (`tauri-plugin-cli`) — ex. `--no-autoupdate`.
- **Updater** (`tauri-plugin-updater`) — vérification de mise à jour au démarrage.
- **Vidéo** (`video_cmds.rs`) — spawn ffmpeg, pipe stdin, encodage. Les fenêtres `play.js` appellent ces commandes **directement** (`start_recording`/`stop_recording`/`record_frame`), sans passer par le worker, qui se contente de déclencher l'action via un event (`emit('start-recording', …)` côté `JBMatch`, traduit en `invoke()` par `worker-bridge.js`).
- **Processus moteurs externes** (`engine_cmds.rs`) — spawn du binaire UCI/CECP/Hub, écriture sur son stdin, lecture ligne à ligne de son stdout, kill. Le **protocole** (quelles commandes UCI envoyer, comment interpréter `bestmove`, etc.) reste en JS dans `jb-engines.js` ; Rust ne fait que piloter le tube du processus.
- **Dialogues** (`tauri-plugin-dialog`) — confirmations, sélection de fichier, message d'erreur.

### Le SharedWorker (`match-worker.js`) gère tout le métier de jeu

Toute la logique applicative — cycle de vie d'une partie, joueurs, horloge, historique, favoris, templates, gestion haut niveau des moteurs — tourne dans un **SharedWorker** partagé entre toutes les fenêtres. `hub.js` instancie ce worker une seule fois au démarrage et lui sert de pont vers Tauri via `worker-bridge.js`.

Avantage du SharedWorker : un seul état de vérité pour tous les matchs en cours, accessible depuis n'importe quelle fenêtre, sans dupliquer l'état ni synchroniser plusieurs copies.

---

## Protocole de communication

Il y a **deux canaux distincts**, dans des sens opposés.

### Canal 1 — Renderer/UI → Rust → Worker (requête/réponse)

Une fenêtre (hub, players, history…) invoque une commande Tauri ; Rust relaie la requête au worker via `worker-bridge.js` et attend la réponse avant de la renvoyer au renderer.

```
players.js
  └─► tRpc.call('set_players', matchId, players)
        └─► invoke('set_players', { matchId, players })
              └─► Rust match_cmds::set_players(...)
                    └─► relais vers worker-bridge.js (port.postMessage({ id, type:'setPlayers', args }))
                          └─► match-worker.js controller.setPlayers(matchId, players)
                                └─► port.postMessage({ id, result })
                    └─► Rust renvoie le résultat au renderer
```

Côté worker, chaque message entrant a un `id` ; la réponse (`{id, result}` ou `{id, error}`) est renvoyée sur ce même `id`. C'est `workerCall(type, ...args)` dans `worker-bridge.js` qui gère ce ping-pong.

**Commandes Tauri qui délèguent au worker** (liste actuelle des méthodes exposées par `controller` dans `match-worker.js`) :

```
new_match, new_clocked_match, clone_match, load_match,
take_back, restart, pause, is_paused, replay_last_move,
get_history, freeze, get_players_info, set_players,
get_clock, get_view_info, set_view_options,
is_favorite, set_favorite, input_move, show_move,
open_book, open_book_match, book_history_view,
load_board_state, show_board_state,
get_camera, set_camera,
play_template, save_template, remove_template, is_template_name_valid,
save_engine, remove_engine
```

**Ne sont *pas* déléguées au worker** (commandes Rust pures, appelées directement par les renderers) :
`start_recording`, `stop_recording`, `record_frame` (vidéo/ffmpeg), `is_file` (validation de chemin), `read_text_file`, `parse_pjn`, `get_app_info`, l'ouverture de fenêtres "statiques" qui ne dépendent pas d'un match (`open_info`, `open_game` peuvent transiter par le worker ou être directes selon le contexte applicatif — à trancher au cas par cas pendant l'implémentation).

### Canal 2 — Worker → Rust → Renderer/UI (events fire-and-forget)

C'est le canal qui permet au worker de **piloter** les fenêtres : afficher un coup, ouvrir/fermer une fenêtre satellite, rafraîchir la liste des favoris du hub, etc. Ces messages n'ont pas d'`id` ; ils ne génèrent pas de réponse attendue par le worker.

```
match-worker.js
  └─► emit('relay', { label: 'play-3', event: 'humanTurn', payload: { gameData } })
        └─► port.postMessage({ type:'event', event:'relay', payload })
              └─► worker-bridge.js::handleWorkerEvent('relay', payload)
                    └─► invoke('relay_to_window', { target:'play-3', event:'humanTurn', payload })
                          └─► Rust win.emit('humanTurn', payload) sur la fenêtre play-3
                                └─► play.js tRpc.listen({ humanTurn: handler })
```

Events émis par le worker et gérés par `handleWorkerEvent` dans `worker-bridge.js` :

| Event | Effet |
|---|---|
| `relay` | `relay_to_window(label, event, payload)` — pousse un event vers une fenêtre cible précise (play, history, clock, moves…) |
| `open-window` | `open_window_for_match(...)` — ouvre une fenêtre play ou clock-setup |
| `close-window` | `close_window(label)` |
| `update-hub` | émis localement dans la fenêtre hub elle-même (favoris/templates/engines mis à jour) |
| `store-set` | persiste une clé dans le store Tauri |
| `match-ended` | `match_ended(matchId)` — nettoie l'état Rust associé au match |
| `book-ready` / `book-error` | ouverture de `book.html` + envoi des parties parsées |
| `show-board-state` | ouverture de `show-position.html` + envoi de l'état du plateau |
| `open-book-history` | ouverture de `book-history.html` + envoi des données de la partie |
| `start-recording` / `stop-recording` / `record-frame` | délégués aux commandes vidéo Rust |
| `error-dialog` | `show_error_dialog(title, message)` |

À l'inverse, certains renderers doivent notifier le worker quand une action côté UI se termine (résultat d'un coup, résultat caméra, ouverture/fermeture d'une fenêtre satellite). `worker-bridge.js` écoute ces events Tauri et les transmet au worker via `workerCall` :

| Event Tauri écouté | Transmis au worker comme |
|---|---|
| `board-action-result` | `boardActionResult(matchId, result)` |
| `board-camera-result` | `boardCameraResult(matchId, camera)` |
| `satellite-ready` | `registerSatellite(matchId, type, label)` |
| `satellite-closed` | `unregisterSatellite(matchId, type)` |
| `play-ready` | `startPlay(matchId)` |

### Moteurs externes (UCI / CECP / Hub / DXP)

Le protocole haut niveau (quelles commandes envoyer, comment parser la réponse) est en JS dans `jb-engines.js` (classes `UciEngine`, `CecpEngine`, `HubEngine`, `DxpEngine`, toutes héritant de `ProcessEngine`/`Engine`). Ce code envoie des requêtes `engine-spawn` / `engine-write` / `engine-kill` via un callback `sendToHub`, qui passe en réalité par `workerCall` (donc avec `id`, réponse attendue) — pas par `emit` simple. Côté Rust, ces trois primitives doivent :

- `engine-spawn` : lancer le binaire (`tauri-plugin-shell` ou `std::process::Command`), retenir un handle de process indexé par un id généré, retourner cet id.
- `engine-write` : écrire une ligne sur le stdin du process identifié.
- `engine-kill` : terminer le process et libérer le handle.

La lecture du stdout doit être streamée en continu vers le worker (event asynchrone, pas une commande à réponse unique), pour que `jb-engines.js::ProcessEngine.receiveLine()` reçoive chaque ligne au fur et à mesure.

---

## Table de correspondance Electron → Tauri

| Electron (JoclyBoard) | Tabulon (Tauri) |
|---|---|
| `ipcMain` / `ipcRenderer` via `rpc.js` | `invoke()` + `emit()`/`listen()` via `tabulon-rpc.js` |
| Main process (Node.js) | SharedWorker (`app/worker/match-worker.js`) |
| `electron-store` | `@tauri-apps/plugin-store`, lu/écrit par le worker via le hub |
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
| `joclyboard-engines.js` (Node, `child_process`) | `jb-engines.js` (SharedWorker) + primitives spawn/write/kill en Rust |
| XHR vers `file://` (`info.js`) | commande Rust `read_text_file` |
| `PJNParser` côté hub | commande Rust `parse_pjn` (extraction des tags) + `PJNParser.js` côté `book-history.html` (parsing fin des coups) |

---

## Travaux restants

Cette section documente l'écart entre l'état actuel du code et l'architecture cible décrite ci-dessus.

### Bloquants résolus dans cette session

- [x] `src-tauri/src/state.rs` et `window_manager.rs` recréés.
- [x] `tauri.conf.json` pointe désormais sur `frontendDist: "../app"`, avec une fenêtre `"main"` explicite chargeant `content/hub.html`.
- [x] `app/package.json` recréé (`@tauri-apps/api`, plugins JS, `jquery`, `js-yaml`, `photonkit`).
- [x] `package.json` (racine) appelle désormais `gulp buildPjnParser` (le nom exact de la tâche exportée par `gulpfile.js`) au lieu de `build-pjn-parser`, qui n'existait pas.
- [x] `styles.css` (inexistant) remplacé par `tabulon.css` dans les 17 pages HTML ; `app/tabulon.css` (copie racine obsolète, strict sous-ensemble de `app/content/tabulon.css`) supprimé.
- [x] `lib.rs` n'enregistre plus `engine_get_move`/`kill_match_engines`/`open_board_state_dialog` (fantômes) : remplacés par `engine_spawn`/`engine_write`/`engine_kill`, réellement implémentés dans `engine_cmds.rs` (spawn via `tauri-plugin-shell`, lecture stdout en continu, écriture stdin, kill).
- [x] `hub_cmds::NotifyRequest` défini ; `match_cmds::notify_user` appelle désormais réellement `push_notify_user` (n'est plus un stub qui retourne `false`).
- [x] `dispatch_to_worker` créé dans `match_cmds.rs` (remplace `dispatch_to_controller`/`dispatch_and_await`, propres à l'architecture legacy) et utilisé par `match_cmds.rs` et `template_cmds.rs`. Toutes les commandes de lecture (`get_players_info`, `get_clock`, `get_view_info`, `get_history`, `is_favorite`, `get_camera`, `is_paused`...) renvoient désormais réellement leur résultat au renderer, au lieu d'être fire-and-forget comme avant.
- [x] `remove_engine` (appelée par `hub.js` mais jamais enregistrée comme commande Tauri) ajoutée et déléguée au worker.
- [x] `JBMatch._sendToHub` défini dans `match-worker.js`. Le couple requête/réponse worker→hub (`emitAndWait`/`{replyTo, result|error}`) est maintenant complet.
- [x] `worker-bridge.js::handleWorkerEvent` implémente réellement `engine-spawn`/`engine-write`/`engine-kill` (invoke Rust + réponse sur le port), et un nouveau `engine-line` relaie chaque ligne de stdout vers `controller.engineLine`, qui route vers la bonne instance `ProcessEngine` via un registre `processId → engine` (ajouté dans `match-worker.js`, alimenté par de nouveaux callbacks `onSpawned`/`onDestroyed` dans `jb-engines.js`).
- [x] **Bug trouvé en vérifiant les sources réelles de Tauri 2.11** : `Emitter::emit()` diffuse l'event à **toutes** les webviews de l'app, pas seulement à celle sur laquelle on l'appelle (`win.emit(...)` n'est *pas* ciblé, contrairement à l'intuition). `relay_to_window` (le mécanisme central de communication vers une fenêtre play/history/clock précise) en était affecté, ainsi que `updateEngines`, `notifyUser`, `engine-line`, `dispatch-to-worker`. Tous corrigés avec `emit_to(label, event, payload)`, qui cible réellement une seule fenêtre.
- [x] **`src-tauri/capabilities/default.json` était cassé** (premier `cargo check` réel, exécuté par fhoudebert) : il déclarait `opener:default`, un plugin jamais enregistré dans `lib.rs` (résidu du scaffold Tauri par défaut — `tauri-build` valide les capabilities au moment du build et refuse de compiler si une permission référencée n'existe pas). Remplacé par les permissions des plugins réellement utilisés (`shell:default`, `dialog:default`, `os:default`, `store:default`), plus `core:window:allow-close` (absent de `core:window:default`, nécessaire pour `getCurrentWindow().close()` dans `tabulon-rpc.js::close()`, utilisé par tous les boutons d'annulation des fenêtres satellites). La capability ne couvrait par ailleurs que `"windows": ["main"]` ; étendue à `["*"]` puisque les fenêtres satellites (play, history, players...) utilisent elles aussi `store`/`os`, et certaines `shell`/`dialog`.
- [x] **Deux vraies erreurs de compilation** (deuxième `cargo check` réel) : `tauri_plugin_fs::Builder` n'existe pas dans ce crate (seule une fonction `init()` est exposée, contrairement à `store`/`updater` qui ont un vrai `Builder` — vérifié dans les sources du crate) ; `app.cli()` nécessitait `tauri_plugin_cli::CliExt` en scope (même famille de pattern que `DialogExt`/`ShellExt`/`StoreExt`). Les deux corrigés dans `lib.rs`.
- [x] **Deux doublons Rust/worker incomplets, découverts en creusant les warnings du même `cargo check`** (variables inutilisées qui cachaient un vrai défaut fonctionnel, pas juste du code mort) :
  - `window_cmds::open_book` ouvrait `book.html` directement en ignorant le contenu du fichier PJN/PGN/PDN choisi par l'utilisateur (`_data` jamais lu), alors que `controller.openBook` côté worker fait déjà ce travail correctement (parsing via `PJNParser.js`, puis ouverture de la fenêtre une fois les parties extraites, via `open_book_window` — une commande Rust distincte, malgré le nom très proche). Corrigé : `open_book` délègue maintenant au worker au lieu de dupliquer l'ouverture de fenêtre.
  - `engine_cmds::save_engine` ne persistait jamais sur disque (`AppState.engines` n'existait qu'en mémoire, perdu à chaque redémarrage), alors que `controller.saveEngine` côté worker écrit déjà dans le store. Plutôt que de tout rediriger vers le worker (`edit_engine` dépend d'un accès synchrone à `AppState.engines` pour pré-remplir son formulaire, qui aurait dû devenir asynchrone), `save_engine` écrit maintenant aussi dans le store, **au même format que le worker** (objet indexé par id, pas un tableau) pour rester lisible par les deux ; et `lib.rs::setup()` recharge ces engines dans `AppState` au démarrage (ce qui ne se faisait pas non plus).
  - `window_cmds::open_book_match` était un stub (`log::info!` + rien) ignorant son paramètre `app` ; délégué au worker (`controller.openBookMatch`) comme `open_book`.

  Ces trois corrections n'ont pas pu être vérifiées par un nouveau `cargo check` (pas de toolchain Rust disponible dans la session qui les a écrites) — relecture manuelle uniquement, à confirmer au prochain build.
- [x] **Premier `npm run dev` réel : panique au démarrage** — `tauri_plugin_updater::Builder::default().build()` lit obligatoirement la section `plugins.updater` de `tauri.conf.json` dès son enregistrement (peu importe si `check_update()` est ensuite appelée ou pas, et peu importe le mode debug/release). Cette section n'existe pas dans `tauri.conf.json`, donc Tauri lui transmet `null`, que le type `Config` du plugin ne sait pas désérialiser (son champ `pubkey` est obligatoire, sans valeur par défaut). **Le plugin updater est désactivé** (commenté dans `lib.rs`, ainsi que l'appel à `check_update()`) jusqu'à ce qu'une vraie config (`pubkey` + `endpoints`) soit définie — voir Priorité moyenne → Updater, plus bas. La dépendance `tauri-plugin-updater` reste dans `Cargo.toml` et `window_manager::check_update` reste compilée (`#[allow(dead_code)]`), prête à être réactivée.
- [x] **Même panique, cette fois pour `plugins.cli`** : `tauri-plugin-cli` a le même défaut (sa struct `Config` n'a pas de `#[derive(Default)]`, contrairement à `store`/`shell`/`dialog`/`os`/`fs` — vérifié dans les sources des 6 plugins pour confirmer que seuls `cli` et `updater` avaient ce problème). Contrairement à `updater`, `cli` ne pouvait pas être simplement désactivé : `lib.rs::setup()` appelle `app.cli().matches()` pour lire le flag `no-autoupdate`. Une section `plugins.cli` minimale a été ajoutée à `tauri.conf.json` (description + l'argument `no-autoupdate` lui-même, déclaré proprement plutôt que de continuer à le lire sans jamais l'avoir défini dans la config CLI).
- [x] **Premier `npm run dev` qui démarre vraiment : fenêtre hub vide (liste de jeux vide), deux bugs distincts dans la console** :
  - `SyntaxError: Unexpected identifier 'tRpc'. import call expects one or two arguments.` — les 16 fichiers `content/*.html` (sauf `book-history.html`) chargeaient leur script avec `<script src="...">` au lieu de `<script type="module" src="...">`, alors que tous ces fichiers JS utilisent `import`/`export`. Sans `type="module"`, le moteur JS interprète `import x from 'y'` comme un appel à la fonction `import()` dynamique, d'où l'erreur de syntaxe — et tout le fichier (donc toute la page) ne s'exécutait pas du tout. Corrigé sur les 16 fichiers.
  - `404 jocly.js` — `frontendDist: "../app"` ne sert que le contenu de `app/`, donc un chemin `../../dist/browser/jocly.js` depuis `app/content/*.html` essaie de sortir de la racine virtuelle servie par Tauri, qui n'a aucune notion du système de fichiers réel au-delà de `frontendDist`. Confirmé dans la doc officielle : `frontendDist` accepte une **liste** de dossiers, dont le contenu est fusionné à la racine (sans préfixe du nom du dossier source) — `frontendDist: ["../app", "../dist"]` permet donc d'avoir `content/hub.html` et `browser/jocly.js` tous deux à la racine virtuelle. Tous les chemins vers `jocly.js` (17 fichiers HTML + `worker-bridge.js`) corrigés de `../../dist/browser/jocly.js` (ou équivalent) vers `../browser/jocly.js`.
- [x] **`TypeError: Module name '@tauri-apps/plugin-shell' does not resolve to a valid URL`** — une fois les scripts réellement exécutés en module (point précédent), le navigateur a tenté de résoudre les imports `@tauri-apps/...` comme des spécificateurs ES standard. Sans bundler (Tabulon n'en a pas — vrais fichiers `.js` servis tels quels), ces "bare specifiers" ne se résolvent jamais : c'est le rôle d'un bundler de les réécrire vers le bon fichier de `node_modules`, ce qui n'existe pas ici. Confirmé dans la doc officielle Tauri : sans bundler, l'API doit être lue depuis `window.__TAURI__` (activé via `app.withGlobalTauri`, déjà `true`), pas via `import` npm. Créé `app/content/tauri-bridge.js`, qui ré-exporte les bons sous-objets de `window.__TAURI__` (noms exacts confirmés en lisant directement le bundle d'injection IIFE de `tauri` et de chaque plugin — `core`, `event`, `window`, `webviewWindow` pour le bundle core ; `shell`, `dialog`, `store`, `os` injectés séparément par chaque plugin Rust) sous forme de vrais exports ES, résolus paresseusement à l'appel (pas capturés au chargement du module, par précaution contre un problème de timing d'injection documenté sur certaines configs — tauri-apps/tauri#12990). Les 13 fichiers qui importaient directement `@tauri-apps/...` importent maintenant depuis ce module-pont (chemin relatif, donc un spécificateur ES valide). Au passage, `app/worker/hub.js` — doublon strict de `app/content/hub.js`, déjà signalé comme "à supprimer" sans jamais l'avoir vraiment été — a été supprimé pour de bon.

### Point de vigilance pour la suite

- `app/content/tabulon-core.js` (architecture legacy, à supprimer — voir plus haut) utilise `new WebviewWindow(...)` pour créer des fenêtres depuis le JS, ce qui nécessite la permission `core:webview:allow-create-webview-window` (absente de `core:webview:default`, et volontairement **non ajoutée** à `capabilities/default.json` pour ne pas réintroduire un besoin lié à du code qu'on prévoit de supprimer). Si ce fichier est réactivé avant d'être supprimé, le runtime échouera silencieusement sur cette permission manquante — ce n'est pas quelque chose que `cargo check` détecte, seul un test manuel de la fonctionnalité le révèlerait.

### Bloquants restants

- [ ] **`play.js` (et potentiellement d'autres fenêtres) reste câblé pour l'architecture legacy.** Il répond aux events `humanTurn`/`aiTurn`/`playMove`/`display`/`setViewOptions`/`getCamera`/`setCamera` via `_reply(token, result)` → `emit('rpc-reply:'+token, ...)`. Dans l'architecture SharedWorker, c'est `match-worker.js` qui attend une réponse via `board-action-result`/`board-camera-result` (avec `matchId`, pas de `token`), relayés par `worker-bridge.js`. **`play.js` doit être réécrit** pour émettre ces deux events au lieu de répondre par token. Les autres fenêtres satellites (`history.js`, `clock.js`, `moves.js`...) doivent aussi émettre `satellite-ready`/`satellite-closed` au lieu de leur mécanisme actuel — à auditer fenêtre par fenêtre.
- [ ] `hub.js` n'instancie toujours pas `worker-bridge.js` (`bridge.init()` jamais appelé) et continue d'utiliser `tRpc.call` direct comme si l'architecture legacy était active — c'est elle qui orchestrait correctement les commandes avant cette session (`jb-controller.js`/`jb-match.js`), donc la basculer vers le worker sans casser l'UI du hub demande une relecture complète de `hub.js`, pas encore faite.
- [ ] **Fichiers introuvables, ni dans ce dépôt ni dans jocly2, ni récupérables depuis `mi-g/joclyboard` (dépôt introuvable publiquement) :**
  - `pjn-parser/*.jison` (grammaire source du parser PJN — sans lui, `gulp buildPjnParser` ne produit pas `app/PJNParser.js`, donc `book-history.html` ne peut pas fonctionner)
  - `app/content/vendor/jocly-pjn/{jocly-pjn.css,jocly-pjn.js,jocly-crc32.js}` (référencés par `book-history.html`)
  - `app/content/vendor/7segment.ttf` (police de l'horloge, référencée dans `tabulon.css`)

  Ces trois manques concernent uniquement `book-history.html` et l'affichage de l'horloge — le reste de l'app n'en dépend pas. Si ces fichiers existent dans une version antérieure du projet ou ailleurs, il faudra les fournir ; sinon `book-history.html` doit être retravaillé sans eux.

### Nettoyage architecture

- [ ] Supprimer (ou geler hors arborescence active) `app/content/tabulon-core.js`, `app/worker/jb-match.js`, `app/worker/jb-controller.js` — architecture legacy abandonnée.
- [x] Code mort dupliqué nettoyé : `hub_cmds.rs` ne contient plus `book_history_view`/`load_board_state`/`remove_engine`/`remove_template` en double ; `window_cmds.rs` ne contient plus de `show_board_state` non enregistrée ni de helper `play_window` orphelin.
- [x] Résidus de scaffold Tauri par défaut supprimés : `app/main.js` ("greet"), `app/app/` (vide), `src/` (scaffold complet, plus référencé par `tauri.conf.json`).
- [x] `app/worker/hub.js`, doublon strict de `app/content/hub.js` (à une ligne vide près) — supprimé.
- [ ] `getPlayersInfo` (worker) doit aussi renvoyer `gameName`, nécessaire pour conditionner l'affichage des niveaux Fairy-Stockfish dans `players.js` selon le jeu.

### Priorité moyenne

- [ ] **Fairy-Stockfish WebAssembly** — intégration de `fairy-stockfish-nnue.wasm` ou `ffish-es6` pour le jeu contre l'ordinateur sans moteur externe (cf. plan dans le prompt de session dédié).
- [ ] **Updater** — configurer la clé publique et l'endpoint dans `tauri.conf.json`.
- [x] **Icons** — régénérées manuellement (Pillow, faute de `tauri-cli` disponible) à partir du logo griffon (`src/assets/tabulon.png`, dossier supprimé une fois les icônes extraites). `icon.icns`/`icon.ico` sont des fichiers valides mais pas garantis identiques à la sortie de `cargo tauri icon` — à régénérer proprement avec l'outil officiel si l'occasion se présente (voir README.md → Useful commands). Attention : l'image source a déjà des coins arrondis ; un éventuel double-arrondi selon la plateforme reste à vérifier visuellement.
- [ ] **DXP engine** — `DxpEngine` dans `jb-engines.js` est un stub qui lève une erreur ; port TCP à implémenter (WebSocket proxy ou `tauri-plugin-net`).
- [ ] **`jquery`/`photonkit`** — `photonkit` reste chargé dans les 17 pages en plus de `tabulon.css` (qui est censé le remplacer à terme). À retirer une fois confirmé que `tabulon.css` couvre bien toutes les classes utilisées. `jquery`, lui, est une vraie dépendance runtime de Jocly (confirmé en inspectant `jocly2/dist/browser/jocly-xdview.js`) — à garder.

### Priorité basse

- [ ] Tests automatisés (Rust : `parse_pjn`, `video_cmds`, `window_manager`).
- [ ] Packaging Linux/Windows/macOS.
- [ ] **Vérification par compilation réelle** : cette session a vérifié le code Rust par relecture attentive et téléchargement des sources exactes des crates (`tauri`, `tauri-plugin-shell`, `tauri-plugin-store`, `tauri-plugin-dialog`) plutôt que par `cargo check`, faute de toolchain Rust suffisamment récent dans l'environnement de la session (réseau restreint, impossible d'installer rustup/cargo ≥ 1.80). **Un `cargo check` réel reste nécessaire avant de considérer le Rust comme validé.**

---

## Installation et démarrage

Voir [README.md](./README.md) — prérequis, build de Jocly (jocly2 → `dist/`),
installation des dépendances, commandes de développement et de build.

---

## Particularités notables

### Le cœur métier reste en JavaScript
`app/worker/match-worker.js` tourne dans un SharedWorker, partagé par toutes les fenêtres de l'application. La bibliothèque Jocly étant une lib JS navigateur, la porter en Rust aurait signifié réécrire le moteur de jeux entier. Le Rust ne fait que gérer fenêtres, store, processus externes et vidéo.

### Pourquoi un SharedWorker et pas la fenêtre hub directement
Un SharedWorker garantit un état unique, partagé, sans avoir à synchroniser plusieurs copies de l'état applicatif entre fenêtres. Toute fenêtre peut en théorie se connecter au même port ; en pratique seul `hub.js` le fait et relaie pour les autres via Tauri events.

### Pattern notifyUser
Seul cas de réponse renderer→main via un dialogue bloquant côté UI. Implémenté avec `tokio::sync::oneshot` dans `hub_cmds.rs` : Rust émet `notifyUser` + token vers hub, hub affiche la bannière, l'utilisateur clique, hub appelle `notify_user_response(token, result)`, Rust résout la Future.

### PJNParser dans book-history.html
`PJNParser.js` est généré par Gulp/Jison en format CommonJS. `book-history.html` inclut un shim CJS minimal pour l'exposer comme `window.PJNParser` avant l'import ES module de `book-history.js`. (Fichier actuellement absent — voir Travaux restants.)

### Enregistrement vidéo
`video_cmds.rs` spawn ffmpeg avec `stdin: piped`. Les frames JPEG arrivent via `record_frame()`, sont décodées depuis le data-URI base64 et écrites directement sur le stdin de ffmpeg (`-f mjpeg -r 30`). `stop_recording()` ferme stdin → ffmpeg finalise le MP4. Ce flux est déclenché par le worker (via `JBMatch.startRecording()` → event `start-recording`) mais les fenêtres `play.js` invoquent aussi les commandes vidéo directement pour l'envoi des frames (`record_frame`), sans repasser par le worker à chaque frame.
