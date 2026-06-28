# Prompt — Session de continuation Tabulon

## Contexte du projet

Tu reprends la migration de **JoclyBoard** (application Electron de jeux de plateau) vers **Tabulon** (même application, portée sur **Tauri 2**). La migration structurelle est complète. Cette session a trois objectifs ordonnés.

---

## Fichiers disponibles

Le projet complet est dans les fichiers joints. Structure :

```
tabulon/
├── README.md                 ← lire en premier
├── ARCHITECTURE.md           ← décision architecturale clé
├── package.json              ← scripts racine
├── gulpfile.mjs
├── app/
│   ├── package.json
│   ├── PJNParser.js
│   ├── core/                 ← cœur métier JS (3 fichiers)
│   │   ├── tabulon-core.js
│   │   ├── jb-match.js
│   │   └── jb-controller.js
│   └── content/              ← 19 fichiers JS + 17 HTML migrés
│       ├── tabulon-rpc.js    ← remplace rpc.js Electron
│       ├── tabulon-winutils.js
│       ├── tabulon.css
│       ├── hub.js/html       ← fenêtre principale
│       ├── play.js/html      ← plateau de jeu
│       └── [15 autres fenêtres]
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── lib.rs            ← 64 commandes Tauri enregistrées
        ├── state.rs
        ├── window_manager.rs
        └── commands/
            ├── match_cmds.rs   ← thin wrappers → controller-call
            ├── window_cmds.rs
            ├── hub_cmds.rs
            ├── engine_cmds.rs  ← engine_get_move à implémenter
            ├── template_cmds.rs
            ├── video_cmds.rs
            └── fs_cmds.rs
```

---

## Objectif 1 — Audit et proposition d'améliorations

Lis **README.md** et **ARCHITECTURE.md** en entier, puis analyse le code source en portant une attention particulière à :

### Points à auditer

**Cohérence du protocole tCore.emit()** (`tabulon-core.js` ↔ `play.js`)
- `tCore.emit(label, event, payload)` envoie `{ payload, token }` via `relay_to_window`
- `play.js` tRpc.listen handlers reçoivent `{ payload, token }` et répondent via `emit('rpc-reply:token')`
- Vérifier que tous les handlers dans `play.js` extraient bien `{ payload, token }` du message reçu et appellent `_reply(token, result)`

**Commandes Rust incomplètes** (corps TODO)
- `engine_cmds::engine_get_move` — stub qui throw, à implémenter avec `tauri-plugin-shell`
- `engine_cmds::kill_match_engines` — idem
- `show_error_dialog` — log uniquement, à connecter à `tauri-plugin-dialog`
- `notify_user` dans match_cmds — retourne false hardcodé

**Cohérence tabulon-rpc.js**
- `buildPayload()` mappe les args positionnels vers les noms Tauri (snake_case→camelCase)
- Vérifier que chaque `tRpc.call('command', arg1, arg2)` dans les 19 fichiers content/ a bien une entrée dans `buildPayload`
- Vérifier que les noms de commandes JS correspondent aux noms Rust (Tauri 2 convertit snake_case → camelCase automatiquement)

**Variables `byline` et `jquery` dans `app/package.json`**
- `byline` était utilisé dans `joclyboard-engines.js` (Node.js) — plus nécessaire
- `jquery` — vérifier s'il est encore référencé dans les HTML (certains l'incluaient, migration en vanilla JS)
- `photonkit` — les fonts Entypo sont encore utilisées via `tabulon.css`, mais la lib CSS est remplacée

**État du store dans `jb-controller.js`**
- `ctrl.openBook()` appelle `tCore.invoke('parse_pjn', { data })` — vérifier que `parse_pjn` est bien dans `tabulon-rpc.js::buildPayload`
- `ctrl.editEngine()` génère un id `String(id)` numérique — cohérent avec `engine_cmds.rs` qui utilise `engine["id"].as_str()`

**`window_cmds::open_board_state_dialog`** — fonction listée dans lib.rs mais à vérifier dans window_cmds.rs

### Format attendu pour l'audit
Liste structurée des problèmes trouvés, classés par sévérité (🔴 bloquant / 🟡 important / 🟢 mineur), avec la correction proposée pour chacun.

---

## Objectif 2 — Finalisation des travaux

Après l'audit, corriger les problèmes identifiés dans cet ordre :

### 2a. Corriger les problèmes bloquants
En priorité tout ce qui empêche un premier `cargo tauri dev` de fonctionner.

### 2b. Implémenter engine_get_move (moteurs UCI/CECP/Hub externes)

Dans `engine_cmds.rs`, implémenter les commandes de gestion des moteurs externes via `tauri-plugin-shell`. Le moteur tourne en sous-processus ; la communication est ligne par ligne (UCI : `go` → `bestmove …`, CECP : `go` → `move …`).

Structure attendue :
```rust
// État global des processus moteurs actifs
pub struct EngineProcesses {
    processes: Mutex<HashMap<String, EngineProcess>>,
}

struct EngineProcess {
    stdin:  ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    config: EngineConfig,
}
```

Les commandes à implémenter :
- `engine_get_move(engine_id, match_id, played_moves, initial_board, clock)` → String (le coup)
- `kill_match_engines(match_id)` → tuer tous les processus du match

Protocoles :
- **UCI** : `ucinewgame` → `position [fen|startpos] moves ...` → `go wtime X btime X` → attendre `bestmove`
- **CECP** : `new` → `force` → replay des coups → `go` → attendre `move`
- **Hub** : `start` → `move` × N → `go` → attendre `move`
- **DXP** : stub TCP (reporter à plus tard)

### 2c. Connecter show_error_dialog à tauri-plugin-dialog
```rust
use tauri_plugin_dialog::DialogExt;
app.dialog().message(message).title(title).blocking_show();
```

### 2d. Connecter notify_user au vrai dialog
Utiliser le pattern `push_notify_user` déjà dans `hub_cmds.rs` avec le channel oneshot.

### 2e. Nettoyer app/package.json
Retirer `byline`, `jquery`, et `photonkit` si confirmé non nécessaires après audit.

### 2f. Générer les icônes
```bash
cargo tauri icon src-tauri/icons/icon.png
```
(nécessite une image PNG 1024×1024 source)

---

## Objectif 3 — Intégration Fairy-Stockfish WebAssembly

L'objectif est de permettre le jeu contre un ordinateur **sans moteur externe à installer**, via une intégration WebAssembly de Fairy-Stockfish directement dans la WebView.

### Choix du package

Deux options disponibles :

**Option A : `fairy-stockfish-nnue.wasm`**
```bash
npm i fairy-stockfish-nnue.wasm
```
- Port WebAssembly direct de Fairy-Stockfish avec support NNUE (réseau de neurones)
- API bas niveau (stdin/stdout simulés)
- Meilleure force de jeu (NNUE)
- Supporte les variantes de jeux de plateau (shogi, xiangqi, makruk, etc.)

**Option B : `ffish-es6`**
```bash
npm i ffish-es6
```
- Bibliothèque haut niveau basée sur Fairy-Stockfish
- API orientée objet (`Board`, `Game`)
- Plus simple à intégrer mais moins flexible pour les variantes exotiques

**Recommandation** : utiliser `fairy-stockfish-nnue.wasm` pour la force de jeu et la compatibilité maximale avec les variantes Jocly.

### Architecture d'intégration

Fairy-Stockfish doit tourner dans un **Web Worker dédié** (calcul intensif hors thread UI) :

```
play.html
  └─ play.js
       └─ stockfish-worker.js  (new Worker)
            └─ fairy-stockfish-nnue.wasm
```

### Fichiers à créer

**`app/content/stockfish-worker.js`** — Worker qui charge et pilote Fairy-Stockfish :
```javascript
// Charger le WASM
importScripts('../node_modules/fairy-stockfish-nnue.wasm/stockfish.js');

let sf = null;
let resolveMove = null;

self.onmessage = async ({ data }) => {
    if (data.type === 'init') {
        sf = await Stockfish();
        sf.addMessageListener(line => {
            if (line.startsWith('bestmove')) {
                const move = line.split(' ')[1];
                if (resolveMove) { resolveMove(move); resolveMove = null; }
            }
        });
        sf.postMessage('uci');
        self.postMessage({ type: 'ready' });
    }
    else if (data.type === 'move') {
        // data: { fen, moves, variant, timeMs }
        resolveMove = null;
        const p = new Promise(r => { resolveMove = r; });
        if (data.variant) sf.postMessage('setoption name UCI_Variant value ' + data.variant);
        sf.postMessage('position fen ' + data.fen + (data.moves ? ' moves ' + data.moves : ''));
        sf.postMessage('go movetime ' + (data.timeMs || 1000));
        const move = await p;
        self.postMessage({ type: 'bestmove', move, reqId: data.reqId });
    }
    else if (data.type === 'stop') {
        sf?.postMessage('stop');
    }
};
```

**Intégration dans `jb-match.js`** — ajouter un type de joueur `ai:stockfish` :

Dans `_nextMoveEngine`, détecter le type `stockfish:N` (où N = force 1-10) :
```javascript
// Dans jb-match.js
async _nextMoveStockfish(player, turn) {
    const fen       = await this.match.getInitialBoardState('fen');
    const moves     = await this.match.getPlayedMoves();
    const movesStr  = await this.match.getMoveString(moves, 'engine');
    const variant   = await this._getVariantName(); // mapping gameName → UCI_Variant
    const timeMs    = this._getStockfishTime(player, turn);

    const engineMove = await tCore.invoke('stockfish_best_move', {
        fen:     fen?.boardState || 'startpos',
        moves:   movesStr.join(' '),
        variant, timeMs,
    });
    const move = await this.match.pickMove(engineMove);
    const gameData = await this.match.save();
    return tCore.emit(this._boardLabel, 'playMove', { gameData, move });
}
```

**Commande Rust `stockfish_best_move`** dans `engine_cmds.rs` — relayer vers la WebView hub via event, attendre la réponse du Worker.

**Alternative plus simple** : faire tourner le Worker directement dans `play.html` et le piloter via `tCore.emit` :

```javascript
// Dans play.js — lancer le worker Stockfish
const sfWorker = new Worker(new URL('./stockfish-worker.js', import.meta.url));
sfWorker.onmessage = ({ data }) => {
    if (data.type === 'bestmove') {
        // Résoudre la promise en attente dans le handler aiTurn
        resolveStockfish?.(data.move);
    }
};

// Dans le handler aiTurn de tRpc.listen :
aiTurn: async ({ payload: data, token }) => {
    // Si le joueur est de type stockfish:N
    if (data.isStockfish) {
        const move = await new Promise(r => {
            resolveStockfish = r;
            sfWorker.postMessage({ type: 'move', ...data.sfParams, reqId: token });
        });
        // Jouer le coup
        await cleanup();
        await joclyMatch.load(data.gameData);
        const res = await joclyMatch.playMove(move);
        await _reply(token, { move, ...res });
    }
    // sinon : machineSearch Jocly normal
}
```

### Mapping variantes Jocly → UCI_Variant Fairy-Stockfish

À construire dans `jb-match.js` :
```javascript
const VARIANT_MAP = {
    'classic-chess':    'chess',
    'chess960':         'chess960',
    'draughts':         'breakthrough', // approximation
    'shogi':            'shogi',
    'xiangqi':          'xiangqi',
    'makruk':           'makruk',
    'sittuyin':         'sittuyin',
    'crazyhouse':       'crazyhouse',
    'atomic':           'atomic',
    'antichess':        'antichess',
    'horde':            'horde',
    // Les jeux sans équivalent utilisent le moteur Jocly natif (ai:N)
};
```

### Intégration dans l'UI

Dans `players.js` — ajouter les niveaux Stockfish dans la liste des types de joueurs :
```javascript
// Après les niveaux AI Jocly existants
if (VARIANT_MAP[gameName]) {  // si le jeu est supporté par Fairy-Stockfish
    ['Easy', 'Medium', 'Hard', 'Expert'].forEach((label, i) => {
        playerTypes.push({
            key:   `stockfish:${[500, 1500, 2500, 4000][i]}`,  // timeMs
            label: `Fairy-Stockfish — ${label}`
        });
    });
}
```

### Points d'attention
- Les fichiers `.wasm` et `.js` de `fairy-stockfish-nnue.wasm` doivent être accessibles depuis la WebView. Avec Tauri, les `node_modules` ne sont pas servis automatiquement — copier les fichiers nécessaires dans `app/vendor/stockfish/` lors du build.
- Les NNUE (.nnue) sont des fichiers binaires volumineux (~60MB pour `nn-*.nnue`). À inclure seulement si la taille du bundle est acceptable, sinon jouer en mode classique (sans réseau de neurones).
- `fairy-stockfish-nnue.wasm` nécessite `SharedArrayBuffer` qui nécessite des headers COOP/COEP. Vérifier que `tauri.conf.json` les autorise ou utiliser `ffish-es6` qui ne les requiert pas.

---

## Informations techniques utiles

### Versions
- Tauri 2.x
- Rust edition 2021, rust-version 1.77
- Node.js ≥ 20
- Jocly 0.9.14

### Commandes utiles
```bash
# Vérifier la compilation Rust sans lancer
cargo check --manifest-path src-tauri/Cargo.toml

# Lancer en dev
cargo tauri dev

# Build release
cargo tauri build

# Vérifier les commandes Tauri enregistrées vs implémentées
python3 -c "
import re
def cmds(p):
    return set(re.findall(r'#\[tauri::command\]\s*pub(?:\s+async)?\s+fn\s+(\w+)', open(p).read()))
base = 'src-tauri/src/commands/'
for m in ['engine_cmds','fs_cmds','hub_cmds','match_cmds','template_cmds','video_cmds','window_cmds']:
    print(m, sorted(cmds(base+m+'.rs')))
"
```

### Pattern dispatch_to_controller
Toutes les commandes `match_cmds.rs` utilisent ce pattern :
```rust
dispatch_to_controller(&app, "methodName", serde_json::json!([arg1, arg2]))
```
Le contrôleur JS reçoit `controller-call` et répond `controller-reply:<token>`.

### Pattern tCore.emit()
Le contrôleur JS appelle :
```javascript
tCore.emit('play-N', 'humanTurn', { gameData })
// → invoke('relay_to_window', { target:'play-N', event:'humanTurn', payload:{ payload:{gameData}, token } })
// → play.js tRpc.listen({ humanTurn: async({ payload, token }) => { ... await _reply(token, result) } })
```

---

## Priorités recommandées pour cette session

1. **Audit complet** (30 min) — identifier tous les problèmes avant de toucher au code
2. **Corrections bloquantes** — tout ce qui empêche la compilation ou le démarrage
3. **Premier `cargo tauri dev`** — l'objectif minimum est que l'app démarre
4. **engine_get_move** — implémenter UCI au moins (le plus utilisé)
5. **Fairy-Stockfish** — intégrer en commençant par chess classique, puis étendre

Bon courage !
