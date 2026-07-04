// app/content/play.js  —  Fenêtre de jeu Tabulon
//
// Architecture simplifiée (voir ARCHITECTURE.md) : Jocly tourne directement
// dans cette fenêtre via window.Jocly (chargé par <script src="../browser/jocly.js">
// dans play.html). Pas de SharedWorker, pas de protocol token/reply vers Rust.
// Chaque fenêtre play.html est autonome et peut coexister avec d'autres instances.
//
// Boucle de jeu :
//   createMatch → attachElement → loop { userTurn → playMove } → fin
// Les boutons (takeback, restart, save/load…) agissent directement sur joclyMatch.

import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';

// ── Paramètres d'URL ──────────────────────────────────────────────────────────
const gameName = new URLSearchParams(window.location.search).get('game') || 'classic-chess';
const matchId  = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);
const viewOptionsFromUrl = (() => {
    try {
        const raw = new URLSearchParams(window.location.search).get('options');
        return raw ? JSON.parse(decodeURIComponent(raw)) : null;
    } catch { return null; }
})();

// ── État ──────────────────────────────────────────────────────────────────────
let joclyMatch = null;
let store      = null;
let loopActive = false;     // true tant que la boucle de jeu tourne
let paused     = false;
let videoRecording = null;

// ── Boucle de jeu ─────────────────────────────────────────────────────────────
// Humain vs Humain uniquement pour l'instant.
// machineSearch sera ajouté quand la gestion des joueurs sera câblée.
async function gameLoop() {
    loopActive = true;
    console.info('[play] gameLoop started');
    try {
        while (loopActive) {
            if (paused) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            let result;
            try {
                // userTurn() attend le coup de l'utilisateur, l'applique en
                // interne (PlayMove + DisplayBoard), et retourne
                // { move, finished, winner }. Il ne faut PAS appeler
                // playMove() après — le coup est déjà joué.
                result = await joclyMatch.userTurn();
            } catch (e) {
                // userTurn() est rejeté si abortUserTurn() est appelé
                // (takeback, restart…) — on recommence la boucle normalement.
                console.info('[play] userTurn aborted:', e.message);
                continue;
            }

            console.info('[play] move played, finished:', result?.finished, 'winner:', result?.winner);

            if (result?.finished) {
                const w = result.winner;
                UpdateFooter(w === 0 ? 'Draw'
                    : w > 0 ? 'Player A wins'
                    : 'Player B wins');
                loopActive = false;
            }
        }
    } catch (e) {
        console.error('[play] gameLoop error:', e);
    }
    console.info('[play] gameLoop ended');
}

// ── Helpers UI ────────────────────────────────────────────────────────────────
function UpdateFooter(text) {
    const el = document.getElementById('board-footer-text');
    if (el) el.textContent = text || '';
}

function UpdatePause() {
    document.getElementById('button-pause').style.display  = paused ? 'none' : '';
    document.getElementById('button-resume').style.display = paused ? '' : 'none';
}

function UpdateFav(fav) {
    document.getElementById('button-favorite-no').style.display  = fav ? 'none' : '';
    document.getElementById('button-favorite-yes').style.display = fav ? '' : 'none';
}

// ── Vidéo ─────────────────────────────────────────────────────────────────────
function RecordFrame() {
    if (!videoRecording || !joclyMatch) return;
    joclyMatch.viewControl('takeSnapshot', { format: 'jpeg' })
        .then(snapshot => tRpc.call('record_frame', matchId, snapshot))
        .catch(() => {});
}
function StopRecording() {
    if (!videoRecording) return;
    clearInterval(videoRecording);
    videoRecording = null;
    tRpc.call('stop_recording', matchId).catch(() => {});
    document.getElementById('button-stop-video').classList.add('hidden');
}
function StartRecording() {
    tRpc.call('start_recording', matchId)
        .then(() => {
            document.getElementById('button-stop-video').classList.remove('hidden');
            videoRecording = setInterval(RecordFrame, 1000 / 30);
        })
        .catch(e => console.warn('[play] StartRecording error:', e));
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    console.info('[play] DOMContentLoaded, game:', gameName, 'id:', matchId);
    store = await Store.load('tabulon.json');

    // ── Titre de la fenêtre ───────────────────────────────────────────────────
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en'] + ' #' + matchId, '.game-header');

    // ── Favoris ───────────────────────────────────────────────────────────────
    tRpc.call('is_favorite', gameName).then(UpdateFav).catch(() => {});
    document.getElementById('button-favorite-no')
        .addEventListener('click', () =>
            tRpc.call('set_favorite', gameName, true).then(() => UpdateFav(true)));
    document.getElementById('button-favorite-yes')
        .addEventListener('click', () =>
            tRpc.call('set_favorite', gameName, false).then(() => UpdateFav(false)));

    // ── Plein écran ───────────────────────────────────────────────────────────
    document.getElementById('button-fullscreen')
        .addEventListener('click', () =>
            document.querySelector('.game-area').webkitRequestFullscreen?.());

    // ── Fenêtres satellites (ouvertes via Rust, pas de logique ici) ───────────
    const btn = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    btn('button-history',  () => tRpc.call('open_history', matchId));
    btn('button-clock',    () => tRpc.call('open_clock', matchId));
    btn('button-players',  () => tRpc.call('open_players', matchId));
    btn('button-options',  () => tRpc.call('open_view_options', matchId));
    btn('button-help',     () => tRpc.call('open_info', gameName));
    btn('button-template', () => tRpc.call('open_save_template', matchId));
    btn('button-clone',    () => tRpc.call('new_match', gameName));
    btn('button-camera',   () => tRpc.call('open_camera_view', matchId, gameName));
    btn('button-moves',    () => tRpc.call('open_moves', matchId));
    btn('button-stop-video', StopRecording);
    btn('button-video',    StartRecording);

    // ── Actions directes sur joclyMatch ──────────────────────────────────────
    btn('button-takeback', async () => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        await joclyMatch.rollback(-1);   // -1 = un coup en arrière
    });

    btn('button-restart', async () => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        await joclyMatch.rollback(0);    // 0 = retour au début
        paused = false;
        UpdatePause();
        if (!loopActive) gameLoop();
    });

    btn('button-pause', () => {
        paused = true;
        joclyMatch?.abortUserTurn().catch(() => {});
        UpdatePause();
    });

    btn('button-resume', () => {
        paused = false;
        UpdatePause();
    });

    // Replay : revenir au coup précédent visuellement sans modifier l'état
    btn('button-replay', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPlayedMoves();
        if (moves && moves.length > 0) {
            await joclyMatch.rollback(moves.length - 1).catch(() => {});
        }
    });

    // Sauvegarde JSON
    btn('button-save', () => {
        joclyMatch?.save().then(data => {
            const a = document.createElement('a');
            a.href = 'data:application/octet-stream,' + encodeURIComponent(JSON.stringify(data, null, 2));
            a.download = gameName + '.json';
            a.click();
        });
    });

    // Chargement JSON
    const fileElem = document.getElementById('fileElem');
    fileElem?.addEventListener('change', async () => {
        if (!joclyMatch || !fileElem.files[0]) return;
        const reader = new FileReader();
        reader.readAsText(fileElem.files[0]);
        reader.onload = async (e) => {
            await joclyMatch.abortUserTurn().catch(() => {});
            await joclyMatch.abortMachineSearch().catch(() => {});
            await joclyMatch.load(JSON.parse(e.target.result));
            loopActive = false;
            paused = false;
            UpdatePause();
            gameLoop();
        };
    });
    btn('button-load', () => fileElem?.click());

    // Snapshot
    btn('button-snapshot', () => {
        joclyMatch?.viewControl('takeSnapshot').then(snapshot => {
            const a = document.createElement('a');
            a.href = snapshot; a.download = gameName + '.png'; a.click();
        }).catch(e => console.warn('[play] Snapshot error:', e));
    });

    // ── Init Jocly ────────────────────────────────────────────────────────────
    console.info('[play] creating Jocly match for', gameName);
    joclyMatch = await Jocly.createMatch(gameName);
    console.info('[play] match created');

    const fullConfig = await joclyMatch.getConfig();
    const supports3D = (() => {
        try { return !!window.WebGLRenderingContext &&
              !!document.createElement('canvas').getContext('experimental-webgl'); }
        catch (e) { return false; }
    })();
    const skins = (fullConfig?.view?.skins || []).filter(s => supports3D || !s['3d']);
    const storedOptions = await store.get('view-options:' + gameName).catch(() => null);
    const defaultSkin = skins[0]?.name;
    let viewOptions = Object.assign({
        sounds: true, notation: false, moves: true,
        autoComplete: false, viewAs: Jocly.PLAYER_A,
    }, fullConfig?.view?.defaultOptions || {}, storedOptions || {}, viewOptionsFromUrl || {});
    if (defaultSkin && !skins.find(s => s.name === viewOptions.skin))
        viewOptions.skin = defaultSkin;

    const gameArea = document.querySelector('.game-area');
    if (!gameArea) throw new Error('[play] .game-area not found in DOM');

    await joclyMatch.attachElement(gameArea, { viewOptions });
    console.info('[play] element attached, starting game loop');

    UpdatePause();
    await twu.ready();

    // Lancer la boucle de jeu
    gameLoop();
});
