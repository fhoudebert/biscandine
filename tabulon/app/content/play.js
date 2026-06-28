// app/content/play.js  —  Fenêtre de jeu principale
//
// Rôle : afficher le plateau Jocly et répondre aux events du contrôleur.
// Le contrôleur (jb-controller.js dans hub.html) pilote la boucle de jeu ;
// play.js reçoit humanTurn/aiTurn/playMove/display via tCore.emit() qui
// passe par relay_to_window (Rust) et répond via "rpc-reply:<token>".

import tRpc        from './tabulon-rpc.js';
import twu         from './tabulon-winutils.js';
import { Store }   from '@tauri-apps/plugin-store';
import { listen, emit } from '@tauri-apps/api/event';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && parseInt(m[1]) || 0;
})();
const viewOptionsFromUrl = (function () {
    const m = /\?.*\boptions=([^&]+)/.exec(window.location.href);
    try { return m && m[1] && JSON.parse(decodeURIComponent(m[1])) || null; }
    catch { return null; }
})();

let joclyMatch, store;
let videoRecording = null;

// ── Cleanup entre les tours ────────────────────────────────────────────────────
async function cleanup() {
    if (!joclyMatch) return;
    await joclyMatch.abortUserTurn().catch(() => {});
    await joclyMatch.abortMachineSearch().catch(() => {});
    await joclyMatch.resetView(true).catch(() => {});
}

// ── Protocol tCore.emit() → reply ────────────────────────────────────────────
// jb-controller.js appelle tCore.emit(label, event, payload) qui :
//   1. invoke('relay_to_window', { target: label, event, payload: { payload, token } })
//   2. attend l'event Tauri "rpc-reply:<token>"
// Ce renderer reçoit l'event, traite, et émet "rpc-reply:<token>".
tRpc.listen({

    humanTurn: async ({ payload: data, token }) => {
        if (!joclyMatch) { await _reply(token, null, 'match not ready'); return; }
        try {
            await cleanup();
            await joclyMatch.load(data.gameData);
            const result = await joclyMatch.userTurn();
            await _reply(token, result);
        } catch (e) { await _reply(token, null, e.message); }
    },

    aiTurn: async ({ payload: data, token }) => {
        if (!joclyMatch) { await _reply(token, null, 'match not ready'); return; }
        try {
            await cleanup();
            await joclyMatch.load(data.gameData);
            const r = await joclyMatch.machineSearch({ level: data.level });
            await joclyMatch.playMove(r.move);
            await _reply(token, r);
        } catch (e) { await _reply(token, null, e.message); }
    },

    playMove: async ({ payload: data, token }) => {
        if (!joclyMatch) { await _reply(token, null, 'match not ready'); return; }
        try {
            await cleanup();
            await joclyMatch.load(data.gameData);
            const res = await joclyMatch.playMove(data.move);
            await _reply(token, { move: data.move, ...res });
        } catch (e) { await _reply(token, null, e.message); }
    },

    display: async ({ payload: data, token }) => {
        if (!joclyMatch) { await _reply(token, {}); return; }
        try {
            await cleanup();
            await joclyMatch.load(data.gameData);
            await _reply(token, {});
        } catch (e) { await _reply(token, null, e.message); }
    },

    setViewOptions: async ({ payload: options, token }) => {
        try {
            if (joclyMatch) {
                await cleanup();
                await joclyMatch.setViewOptions(options);
            }
            await _reply(token, {});
        } catch (e) { await _reply(token, null, e.message); }
    },

    setFooterText: ({ payload: text }) => {
        document.getElementById('board-footer-text').textContent = text || '';
    },

    getCamera: async ({ token }) => {
        try {
            const camera = joclyMatch ? await joclyMatch.viewControl('getCamera') : null;
            await _reply(token, camera);
        } catch (e) { await _reply(token, null, e.message); }
    },

    setCamera: async ({ payload: details, token }) => {
        try {
            if (joclyMatch) await joclyMatch.viewControl('setCamera', details);
            await _reply(token, {});
        } catch (e) { await _reply(token, null, e.message); }
    },
});

async function _reply(token, result, error) {
    if (!token) return;
    await emit('rpc-reply:' + token, error ? { error } : { result });
}

// ── Vidéo ─────────────────────────────────────────────────────────────────────
function RecordFrame() {
    if (!videoRecording || !joclyMatch) return;
    joclyMatch.viewControl('takeSnapshot', { format: 'jpeg' })
        .then(snapshot => tRpc.call('record_frame', matchId, snapshot))
        .catch(() => {});
}

function StopRecording() {
    if (videoRecording) {
        clearInterval(videoRecording);
        videoRecording = null;
        tRpc.call('stop_recording', matchId).catch(() => {});
        document.getElementById('button-stop-video').classList.add('hidden');
    }
}

function StartRecording() {
    tRpc.call('start_recording', matchId)
        .then(() => {
            document.getElementById('button-stop-video').classList.remove('hidden');
            videoRecording = setInterval(RecordFrame, 1000 / 30);
        })
        .catch(e => console.warn('StartRecording error:', e));
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    store = await Store.load('tabulon.json');

    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en'] + ' #' + matchId, '.game-header');

    // Favoris
    const btnFavNo  = document.getElementById('button-favorite-no');
    const btnFavYes = document.getElementById('button-favorite-yes');
    function UpdateFav(fav) {
        btnFavNo.style.display  = fav ? 'none' : '';
        btnFavYes.style.display = fav ? '' : 'none';
    }
    tRpc.call('is_favorite', gameName).then(UpdateFav);
    btnFavNo.addEventListener('click',  () => tRpc.call('set_favorite', gameName, true).then(() => UpdateFav(true)));
    btnFavYes.addEventListener('click', () => tRpc.call('set_favorite', gameName, false).then(() => UpdateFav(false)));

    // Plein écran
    document.getElementById('button-fullscreen').addEventListener('click', () => {
        document.querySelector('.game-area').webkitRequestFullscreen?.();
    });

    // Boutons de contrôle
    const btn = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    btn('button-takeback',  () => tRpc.call('take_back', matchId));
    btn('button-restart',   () => tRpc.call('restart', matchId));
    btn('button-history',   () => tRpc.call('open_history', matchId));
    btn('button-clock',     () => tRpc.call('open_clock', matchId));
    btn('button-replay',    () => tRpc.call('replay_last_move', matchId));
    btn('button-pause',     () => tRpc.call('pause', matchId, true)
        .then(() => UpdatePause()));
    btn('button-resume',    () => tRpc.call('pause', matchId, false)
        .then(() => UpdatePause()));
    btn('button-players',   () => tRpc.call('open_players', matchId));
    btn('button-options',   () => tRpc.call('open_view_options', matchId));
    btn('button-help',      () => tRpc.call('open_info', gameName));
    btn('button-template',  () => tRpc.call('open_save_template', matchId));
    btn('button-clone',     () => tRpc.call('clone_match', matchId));
    btn('button-camera',    () => tRpc.call('open_camera_view', matchId, gameName));
    btn('button-moves',     () => tRpc.call('open_moves', matchId));
    btn('button-stop-video', StopRecording);
    btn('button-video',     StartRecording);

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
    fileElem?.addEventListener('change', function () {
        const reader = new FileReader();
        reader.readAsText(fileElem.files[0]);
        reader.onload = e => tRpc.call('load_match', matchId, JSON.parse(e.target.result));
    });
    btn('button-load', () => fileElem?.click());

    // Snapshot
    btn('button-snapshot', () => {
        joclyMatch?.viewControl('takeSnapshot').then(snapshot => {
            const a = document.createElement('a');
            a.href = snapshot; a.download = gameName + '.png'; a.click();
        }).catch(e => console.warn('Snapshot error:', e));
    });

    function UpdatePause() {
        tRpc.call('is_paused', matchId).then(paused => {
            document.getElementById('button-pause').style.display  = paused ? 'none' : '';
            document.getElementById('button-resume').style.display = paused ? '' : 'none';
        });
    }
    UpdatePause();

    // ── Init Jocly ────────────────────────────────────────────────────────────
    joclyMatch = await Jocly.createMatch(gameName);
    const fullConfig = await joclyMatch.getConfig(config);

    const supports3D = (() => {
        try { return !!window.WebGLRenderingContext &&
              !!document.createElement('canvas').getContext('experimental-webgl'); }
        catch { return false; }
    })();
    const skins = (fullConfig.view.skins || []).filter(s => supports3D || !s['3d']);

    const storedOptions = await store.get('view-options:' + gameName);
    let viewOptions = Object.assign({
        sounds: true, notation: false, moves: true,
        autoComplete: false, viewAs: Jocly.PLAYER_A,
    }, fullConfig.view.defaultOptions, storedOptions, viewOptionsFromUrl);
    if (!skins.find(s => s.name === viewOptions.skin))
        viewOptions.skin = skins[0]?.name;

    await joclyMatch.attachElement(document.querySelector('.game-area'), { viewOptions });

    // Signaler que la fenêtre est prête (twu.ready() émet 'window-ready')
    await twu.ready();
});
