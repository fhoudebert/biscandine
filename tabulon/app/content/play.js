// app/content/play.js -- Fenetre de jeu Tabulon
//
// Jocly tourne dans un iframe (attachElement -> mode proxy). Dans ce mode :
//   - userTurn() joue le coup en interne, retourne {move, finished, winner}
//     -> pas besoin de playMove() apres
//   - machineSearch() cherche mais NE JOUE PAS le coup, retourne {move, ...}
//     -> il faut appeler playMove(result.move) apres (comme control.js)
//   - Si result.move est undefined (niveau IA non supporte pour ce jeu/position),
//     on logge un warning et on reboucle en humain plutot que boucler infiniment.

import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';
import { Store, listen, emit } from './tauri-bridge.js';

// -- Parametres d'URL ---------------------------------------------------------
const gameName = new URLSearchParams(window.location.search).get('game') || 'classic-chess';
const matchId  = parseInt(new URLSearchParams(window.location.search).get('id') || '0', 10);
const viewOptionsFromUrl = (() => {
    try {
        const raw = new URLSearchParams(window.location.search).get('options');
        return raw ? JSON.parse(decodeURIComponent(raw)) : null;
    } catch { return null; }
})();

// -- Etat ---------------------------------------------------------------------
let joclyMatch   = null;
let store        = null;
let loopActive   = false;
let paused       = false;
let videoRecording = null;
let levels       = [];

// Joueurs : null = humain, sinon objet level Jocly
const players = {};

// -- Boucle de jeu ------------------------------------------------------------
async function gameLoop() {
    loopActive = true;
    console.info('[play] gameLoop started');
    try {
        while (loopActive) {
            if (paused) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            const turn = await joclyMatch.getTurn();
            const level = players[turn];   // null = humain, objet = IA

            let finished = false;
            let winner   = null;

            try {
                if (!level) {
                    // Tour humain.
                    // userTurn() joue le coup en interne (mode proxy iframe)
                    // et retourne {move, finished, winner} directement.
                    const result = await joclyMatch.userTurn();
                    finished = result?.finished || false;
                    winner   = result?.winner;

                } else {
                    // Tour IA.
                    // machineSearch() en mode proxy iframe retourne {move, ...}
                    // mais NE joue PAS le coup -- il faut appeler playMove().
                    UpdateFooter('Thinking...');
                    const result = await joclyMatch.machineSearch({ level });
                    UpdateFooter('');

                    if (!result?.move) {
                        // Le niveau demande n'est pas disponible pour ce jeu
                        // ou cette position (ex. expert fairy-stockfish sur un
                        // jeu non supporte, ou prelude pas encore resolu).
                        // On tombe en mode humain plutot que boucler sans fin.
                        console.warn('[play] machineSearch returned no move for level', level.name,
                            '-- falling back to human turn');
                        const r2 = await joclyMatch.userTurn();
                        finished = r2?.finished || false;
                        winner   = r2?.winner;
                    } else {
                        const playResult = await joclyMatch.playMove(result.move);
                        finished = playResult?.finished || false;
                        winner   = playResult?.winner;
                    }
                }
            } catch (e) {
                // abortUserTurn() / abortMachineSearch() -> reboucler
                console.info('[play] turn aborted:', e.message);
                UpdateFooter('');
                continue;
            }

            if (finished) {
                UpdateFooter(winner === 0 ? 'Draw'
                    : winner > 0 ? 'Player A wins'
                    : 'Player B wins');
                loopActive = false;
            }
            // Notifier les satellites (history.js) qu'un coup a ete joue
            emit(`play-event:${matchId}:move-played`, null).catch(() => {});
        }
    } catch (e) {
        console.error('[play] gameLoop error:', e);
        UpdateFooter('');
    }
    console.info('[play] gameLoop ended');
}

// -- Helpers UI ---------------------------------------------------------------
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

function BuildPlayerSelect(selectId, playerKey) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';

    const optHuman = document.createElement('option');
    optHuman.value = '';
    optHuman.textContent = 'Human';
    sel.appendChild(optHuman);

    levels.forEach((lvl, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = lvl.label || lvl.name || ('Level ' + (i + 1));
        sel.appendChild(opt);
    });

    // Defaut : A = humain, B = premier niveau IA (si disponible)
    if (playerKey === Jocly.PLAYER_B && levels.length > 0) {
        players[playerKey] = levels[0];
        sel.value = '0';
    } else {
        players[playerKey] = null;
        sel.value = '';
    }

    sel.addEventListener('change', async () => {
        const v = sel.value;
        players[playerKey] = v === '' ? null : levels[parseInt(v, 10)];
        await joclyMatch?.abortUserTurn().catch(() => {});
        await joclyMatch?.abortMachineSearch().catch(() => {});
    });
}

// -- Video --------------------------------------------------------------------
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

// -- Communication avec les fenetres satellites --------------------------------
// Protocole simple via Tauri events :
//   satellite -> play.html : emit('play-req:{matchId}:{action}', payload)
//   play.html -> satellite : emit('play-rep:{matchId}:{action}', result)
function initSatelliteListeners() {
    const prefix = `play-req:${matchId}:`;

    // get-view-options : retourne viewOptions actuelles + config vue
    listen(prefix + 'get-view-options', async () => {
        if (!joclyMatch) return;
        const opts   = await joclyMatch.getViewOptions().catch(() => ({}));
        const cfg    = await joclyMatch.getConfig().catch(() => ({}));
        await emit(`play-rep:${matchId}:get-view-options`, { options: opts, config: cfg.view || {} });
    });

    // set-view-options : applique les options de vue
    listen(prefix + 'set-view-options', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.setViewOptions(payload || {}).catch(e => console.warn('[play] setViewOptions:', e));
        // Persister dans le store pour la prochaine ouverture
        store?.set('view-options:' + gameName, payload || {});
    });

    // get-players : retourne les joueurs actuels + niveaux disponibles
    listen(prefix + 'get-players', async () => {
        if (!joclyMatch) return;
        const cfg = await joclyMatch.getConfig().catch(() => ({}));
        await emit(`play-rep:${matchId}:get-players`, {
            levels:  cfg.model?.levels || [],
            players: {
                [Jocly.PLAYER_A]: { type: players[Jocly.PLAYER_A] ? 'ai' : 'human', levelIndex: levels.indexOf(players[Jocly.PLAYER_A]) },
                [Jocly.PLAYER_B]: { type: players[Jocly.PLAYER_B] ? 'ai' : 'human', levelIndex: levels.indexOf(players[Jocly.PLAYER_B]) },
            },
        });
    });

    // set-players : change les types de joueurs
    // payload : { [PLAYER_A]: { type:'human'|'ai', levelIndex:N }, ... }
    listen(prefix + 'set-players', async ({ payload }) => {
        if (!joclyMatch || !payload) return;
        const abort = async () => {
            await joclyMatch.abortUserTurn().catch(() => {});
            await joclyMatch.abortMachineSearch().catch(() => {});
        };
        let changed = false;
        for (const [playerKey, info] of Object.entries(payload)) {
            const key = parseInt(playerKey, 10);
            const newLevel = info.type === 'ai' && levels[info.levelIndex] ? levels[info.levelIndex] : null;
            if (JSON.stringify(players[key]) !== JSON.stringify(newLevel)) {
                players[key] = newLevel;
                changed = true;
            }
        }
        if (changed) await abort();
        // Mettre a jour les selects dans play.html
        [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach(key => {
            const selId = key === Jocly.PLAYER_A ? 'select-player-a' : 'select-player-b';
            const sel = document.getElementById(selId);
            if (!sel) return;
            const info = payload[key];
            sel.value = (info?.type === 'ai' && info.levelIndex >= 0) ? String(info.levelIndex) : '';
        });
    });

    // get-played-moves : retourne l'historique des coups comme strings lisibles
    listen(prefix + 'get-played-moves', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPlayedMoves().catch(() => []);
        if (!moves || moves.length === 0) {
            await emit(`play-rep:${matchId}:get-played-moves`, { moves: [] });
            return;
        }
        // getMoveString accepte un array et retourne un array de strings
        // en une seule transaction avec l'iframe -- plus fiable que n appels
        // séquentiels où la sérialisation JSON des objets move peut les corrompre.
        const strings = await joclyMatch.getMoveString(moves).catch(() => null);
        await emit(`play-rep:${matchId}:get-played-moves`, {
            moves: Array.isArray(strings) ? strings : moves.map(() => '?')
        });
    });

    // rollback-to : annuler jusqu'a l'index demande
    listen(prefix + 'rollback-to', async ({ payload }) => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        await joclyMatch.rollback(payload?.index ?? 0).catch(e => console.warn('[play] rollback:', e));
    });

    // get-possible-moves : retourne les coups possibles depuis la position actuelle
    listen(prefix + 'get-possible-moves', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPossibleMoves().catch(() => []);
        await emit(`play-rep:${matchId}:get-possible-moves`, { moves: moves || [] });
    });
}

// -- DOMContentLoaded ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    console.info('[play] DOMContentLoaded, game:', gameName, 'id:', matchId);
    store = await Store.load('tabulon.json');

    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en'] + ' #' + matchId, '.game-header');

    levels = config.model.levels || [];
    BuildPlayerSelect('select-player-a', Jocly.PLAYER_A);
    BuildPlayerSelect('select-player-b', Jocly.PLAYER_B);

    // Favoris
    tRpc.call('is_favorite', gameName).then(UpdateFav).catch(() => {});
    document.getElementById('button-favorite-no')
        ?.addEventListener('click', () =>
            tRpc.call('set_favorite', gameName, true).then(() => UpdateFav(true)));
    document.getElementById('button-favorite-yes')
        ?.addEventListener('click', () =>
            tRpc.call('set_favorite', gameName, false).then(() => UpdateFav(false)));

    document.getElementById('button-fullscreen')
        ?.addEventListener('click', () =>
            document.querySelector('.game-area').webkitRequestFullscreen?.());

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

    btn('button-takeback', async () => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});

        const moves = await joclyMatch.getPlayedMoves().catch(() => []);
        const n = moves?.length || 0;
        if (n === 0) return;

        // Reculer coup par coup jusqu'à trouver une position où c'est
        // au tour d'un humain de jouer, en utilisant getTurn() comme
        // source de vérité (fiable pour tous les jeux, y compris ceux
        // où le premier joueur n'est pas PLAYER_A).
        for (let target = n - 1; target >= 0; target--) {
            await joclyMatch.rollback(target);
            if (target === 0) break;  // début de partie, on s'arrête
            const turn = await joclyMatch.getTurn().catch(() => null);
            if (!players[turn]) break;  // tour humain trouvé
        }
    });

    btn('button-restart', async () => {
        if (!joclyMatch) return;
        await joclyMatch.abortUserTurn().catch(() => {});
        await joclyMatch.abortMachineSearch().catch(() => {});
        await joclyMatch.rollback(0);
        paused = false;
        UpdatePause();
        UpdateFooter('');
        if (!loopActive) gameLoop();
    });

    btn('button-pause', () => {
        paused = true;
        joclyMatch?.abortUserTurn().catch(() => {});
        joclyMatch?.abortMachineSearch().catch(() => {});
        UpdatePause();
    });

    btn('button-resume', () => {
        paused = false;
        UpdatePause();
    });

    btn('button-replay', async () => {
        if (!joclyMatch) return;
        const moves = await joclyMatch.getPlayedMoves();
        if (moves?.length > 0)
            await joclyMatch.rollback(moves.length - 1).catch(() => {});
    });

    btn('button-save', () => {
        joclyMatch?.save().then(data => {
            const a = document.createElement('a');
            a.href = 'data:application/octet-stream,' + encodeURIComponent(JSON.stringify(data, null, 2));
            a.download = gameName + '.json';
            a.click();
        });
    });

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
            UpdateFooter('');
            gameLoop();
        };
    });
    btn('button-load', () => fileElem?.click());

    btn('button-snapshot', () => {
        joclyMatch?.viewControl('takeSnapshot').then(snapshot => {
            const a = document.createElement('a');
            a.href = snapshot; a.download = gameName + '.png'; a.click();
        }).catch(e => console.warn('[play] Snapshot error:', e));
    });

    // Init Jocly
    console.info('[play] creating Jocly match for', gameName);
    joclyMatch = await Jocly.createMatch(gameName);

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

    // Câblage des fenêtres satellites : elles envoient des events Tauri
    // vers play.html pour lire/modifier l'état du match (view options, players,
    // historique, coups possibles). play.html répond en émettant un event retour.
    // Convention : requête  = 'play-req:{matchId}:{action}'
    //              réponse  = 'play-rep:{matchId}:{action}'
    initSatelliteListeners();

    UpdatePause();
    await twu.ready();
    gameLoop();
});
