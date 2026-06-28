// app/worker/worker-bridge.js
//
// Connecteur entre hub.js, le SharedWorker (match-worker.js) et les Tauri events.
//
// Usage dans hub.js :
//   import bridge from './worker/worker-bridge.js';
//   await bridge.init();
//   const matchId = await bridge.call('newMatch', 'classic-chess');

import { invoke, emit, listen, Store } from '../content/tauri-bridge.js';

let worker   = null;
let store    = null;
let msgId    = 0;
const pending = {};   // id → { resolve, reject }

// ── Appel vers le worker ──────────────────────────────────────────────────────
function workerCall(type, ...args) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending[id] = { resolve, reject };
        worker.port.postMessage({ id, type, args });
    });
}

// ── Gestion des événements émis par le worker ─────────────────────────────────
async function handleWorkerEvent(event, payload) {
    switch (event) {

        // Ouvrir une fenêtre via Rust
        case 'open-window':
            await invoke('open_window_for_match', payload);
            break;

        // Fermer une fenêtre via Rust
        case 'close-window':
            await invoke('close_window', { label: payload.label });
            break;

        // Relayer un event Tauri vers un renderer cible (play, history, clock, moves…)
        case 'relay':
            await invoke('relay_to_window', {
                target:  payload.label,
                event:   payload.event,
                payload: payload.payload,
            }).catch(() => {}); // La fenêtre peut être fermée
            break;

        // Émettre vers la fenêtre hub elle-même (updateFavorites, updateTemplates…)
        case 'update-hub':
            // On émet localement — hub.js écoute via tRpc.listen
            await emit(payload.event, payload.payload);
            break;

        // Persistance store
        case 'store-set':
            await store.set(payload.key, payload.value);
            await store.save();
            break;

        // Match terminé → nettoyer l'état Rust
        case 'match-ended':
            await invoke('match_ended', { matchId: payload.matchId }).catch(() => {});
            break;

        // Livre chargé → ouvrir book.html + envoyer les matches
        case 'book-ready': {
            // Ouvrir la fenêtre book via Rust
            await invoke('open_book_window', {
                gameName: payload.gameName,
                fileName: payload.fileName,
            });
            // Envoyer les matches à la fenêtre book (elle écoute 'setBookMatches')
            const label = 'book-' + payload.gameName;
            await invoke('relay_to_window', {
                target:  label,
                event:   'setBookMatches',
                payload: payload.bookMatches,
            }).catch(() => {});
            break;
        }

        case 'book-error': {
            const label = 'book-' + payload.gameName;
            await invoke('relay_to_window', {
                target: label, event: 'error', payload: payload.error
            }).catch(() => {});
            break;
        }

        // Afficher l'état du plateau
        case 'show-board-state':
            await invoke('open_show_position', {
                gameName: payload.gameName,
                matchId:  payload.matchId,
            });
            // Envoyer le contenu
            await invoke('relay_to_window', {
                target:  `board-state-${payload.gameName}-${payload.matchId}`,
                event:   'setPosition',
                payload: payload.boardState,
            }).catch(() => {});
            break;

        // Ouvrir book-history
        case 'open-book-history':
            await invoke('open_book_history', { matchId: payload.matchId });
            // Envoyer les données de la partie
            await invoke('relay_to_window', {
                target:  `book-history-${payload.matchId}`,
                event:   'setMatchData',
                payload: payload.matchData,
            }).catch(() => {});
            break;

        // Vidéo
        case 'start-recording':
            await invoke('start_recording', { matchId: payload.matchId });
            break;
        case 'stop-recording':
            await invoke('stop_recording',  { matchId: payload.matchId });
            break;
        case 'record-frame':
            await invoke('record_frame',    { matchId: payload.matchId, snapshot: payload.frame });
            break;

        // Dialog d'erreur
        case 'error-dialog':
            await invoke('show_error_dialog', payload).catch(() => {});
            break;

        // Spawn/write/kill moteur → délégué à Rust.
        // Ces 3 events viennent de JBMatch._sendToHub() (via emitAndWait côté
        // worker, voir match-worker.js), donc payload.reqId est toujours
        // présent : on doit répondre directement sur le port avec
        // { replyTo: reqId, result|error }, pas via workerCall (qui créerait
        // une requête dans le mauvais sens).
        case 'engine-spawn': {
            const { reqId, ...spawnArgs } = payload;
            try {
                const result = await invoke('engine_spawn', spawnArgs);
                worker.port.postMessage({ replyTo: reqId, result });
            } catch (e) {
                worker.port.postMessage({ replyTo: reqId, error: String(e) });
            }
            break;
        }
        case 'engine-write': {
            const { reqId, processId, text } = payload;
            try {
                await invoke('engine_write', { processId, text });
                worker.port.postMessage({ replyTo: reqId, result: null });
            } catch (e) {
                worker.port.postMessage({ replyTo: reqId, error: String(e) });
            }
            break;
        }
        case 'engine-kill': {
            const { reqId, processId } = payload;
            try {
                await invoke('engine_kill', { processId });
                worker.port.postMessage({ replyTo: reqId, result: null });
            } catch (e) {
                worker.port.postMessage({ replyTo: reqId, error: String(e) });
            }
            break;
        }

        default:
            console.warn('[bridge] unknown worker event:', event, payload);
    }
}

// ── Initialisation ────────────────────────────────────────────────────────────
async function init() {
    store = await Store.load('tabulon.json');

    // Créer le SharedWorker
    worker = new SharedWorker(new URL('./match-worker.js', import.meta.url), {
        type: 'module',
        name: 'tabulon-match-worker',
    });

    worker.port.onmessage = ({ data }) => {
        if (data.type === 'event') {
            // Event asynchrone du worker
            handleWorkerEvent(data.event, data.payload);
            return;
        }
        // Réponse à un appel workerCall()
        const p = pending[data.id];
        if (!p) return;
        delete pending[data.id];
        if (data.error) p.reject(new Error(data.error));
        else            p.resolve(data.result);
    };
    worker.port.start();

    // Injecter Jocly dans le worker (chargé via <script> tag dans hub.html)
    // dist/ (build de jocly2 via gulp build) est fusionné à la racine de
    // l'app via tauri.conf.json::build.frontendDist (liste ["../app", "../dist"]),
    // donc son contenu (browser/...) est servi directement à la racine, sans
    // préfixe "dist/" — voir README.md → installation.
    const joclyUrl = new URL('../browser/jocly.js', import.meta.url).href;
    await workerCall('inject-jocly', joclyUrl);

    // Synchroniser le store avec le worker
    const allKeys = await store.keys();
    const snapshot = {};
    for (const k of allKeys) snapshot[k] = await store.get(k);
    await workerCall('sync-store', snapshot);

    // Écouter les events Tauri qui viennent des renderers secondaires
    // et les router vers le worker

    // play.js : résultat d'un tour (humanTurn / aiTurn / playMove)
    listen('board-action-result', ({ payload }) => {
        workerCall('boardActionResult', payload.matchId, payload.result).catch(() => {});
    });

    // play.js : résultat getCamera
    listen('board-camera-result', ({ payload }) => {
        workerCall('boardCameraResult', payload.matchId, payload.camera).catch(() => {});
    });

    // Fenêtres satellites : enregistrement (ready) et désenregistrement (closed)
    listen('satellite-ready', ({ payload }) => {
        workerCall('registerSatellite', payload.matchId, payload.type, payload.label).catch(() => {});
    });
    listen('satellite-closed', ({ payload }) => {
        workerCall('unregisterSatellite', payload.matchId, payload.type).catch(() => {});
    });

    // Fenêtre play prête → démarrer la boucle de jeu
    listen('play-ready', ({ payload }) => {
        workerCall('startPlay', payload.matchId).catch(() => {});
    });

    // Ligne de stdout d'un processus moteur externe (engine_cmds.rs).
    // Route vers controller.engineLine, qui retrouve l'instance ProcessEngine
    // via son registre processId→engine (voir match-worker.js).
    listen('engine-line', ({ payload }) => {
        workerCall('engineLine', payload.processId, payload.line).catch(() => {});
    });

    // Requête renderer → Rust → worker (match_cmds.rs::dispatch_to_worker).
    // Remplace l'ancien controller-call/controller-reply : un renderer a
    // invoqué une commande Tauri (new_match, set_players, get_history…),
    // Rust nous demande de l'exécuter sur le worker et attend la réponse.
    listen('dispatch-to-worker', async ({ payload }) => {
        const { method, args, token } = payload;
        try {
            const result = await workerCall(method, ...(Array.isArray(args) ? args : [args]));
            await emit('worker-reply:' + token, { result });
        } catch (e) {
            await emit('worker-reply:' + token, { error: e.message || String(e) });
        }
    });
}

// ── API publique ──────────────────────────────────────────────────────────────
const bridge = {
    init,
    call: (type, ...args) => workerCall(type, ...args),
};

export default bridge;
