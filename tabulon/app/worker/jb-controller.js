// app/core/jb-controller.js
//
// Port de la variable `controller` de joclyboard.js.
// Gère le cycle de vie des matchs, templates, engines, favoris.
// Tourne dans la fenêtre hub et répond aux invoke() Tauri via
// les commandes Rust qui le redélèguent ici via un event "controller-call".

import tCore        from './tabulon-core.js';
import { JBMatch }  from './jb-match.js';
import { listen }   from '@tauri-apps/api/event';

// Registre des matchs vivants : id → JBMatch
const matches = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMatch(matchId) {
    const m = matches.get(Number(matchId));
    if (!m) throw new Error('No such match id: ' + matchId);
    return m;
}

// Nettoie l'action en cours puis relance play() quoi qu'il arrive
async function matchAction(matchId, fn) {
    const m = getMatch(matchId);
    try { await fn(m); } catch(e) { /* ignore */ }
    m.play().catch(() => {});
}

// ── Contrôleur ────────────────────────────────────────────────────────────────

const ctrl = {

    // ── Jeux ──────────────────────────────────────────────────────────────────

    openGame(gameName) {
        return tCore.openWindow({
            label: 'game-' + gameName,
            url:   `content/game.html?game=${gameName}`,
            title: gameName,
            width: 500, height: 400,
            persistKey: 'window:game:' + gameName,
        });
    },

    openInfo(gameName) {
        return tCore.openWindow({
            label: 'info-' + gameName,
            url:   `content/info.html?game=${gameName}`,
            title: 'About ' + gameName,
            width: 600, height: 400,
        });
    },

    // ── Matchs ────────────────────────────────────────────────────────────────

    async newMatch(gameName, clock) {
        const m = new JBMatch(gameName);
        await m.init(clock);
        matches.set(m.id, m);
        await m.displayBoard();
        m.play().catch(() => {});
        return m.id;
    },

    newClockedMatch(gameName) {
        return tCore.openWindow({
            label: 'clock-setup-' + gameName,
            url:   `content/clock-setup.html?game=${gameName}`,
            title: gameName + ' clock setup',
            width: 400, height: 360,
        });
    },

    async cloneMatch(matchId) {
        const [m, template] = await ctrl.getTemplateData(matchId);
        const gameData = await m.match.save();
        return ctrl.playTemplateData(template, gameData);
    },

    async loadMatch(matchId, data) {
        return matchAction(matchId, m => m.load(data));
    },

    async takeBack(matchId, index) {
        return matchAction(matchId, m => m.takeBack(index));
    },

    async restart(matchId) {
        return matchAction(matchId, m => m.restart());
    },

    async pause(matchId, paused) {
        return matchAction(matchId, m => m.pause(paused));
    },

    isPaused(matchId) {
        return !!getMatch(matchId).paused;
    },

    async replayLastMove(matchId) {
        return matchAction(matchId, m => m.replayLastMove());
    },

    // ── Fenêtres satellites ───────────────────────────────────────────────────

    openHistory(matchId)    { return getMatch(matchId).openHistory(); },
    openClock(matchId)      { return getMatch(matchId).openClock(); },
    openPlayers(matchId)    { return getMatch(matchId).openPlayers(); },
    openViewOptions(matchId){ return getMatch(matchId).openViewOptions(); },
    openCameraView(matchId) { return getMatch(matchId).openCameraView(); },
    openMoves(matchId)      { return getMatch(matchId).openMoves(); },

    async openSaveTemplate(matchId) {
        const templates    = await tCore.storeGet('templates') || {};
        const m            = getMatch(matchId);
        let   templateName = m.templateName;
        if (!templateName) {
            let i = 1;
            while (templates['Template-' + i]) i++;
            templateName = 'Template-' + i;
        }
        return tCore.openWindow({
            label: 'save-template-' + matchId,
            url:   `content/save-template.html?id=${matchId}&name=${templateName}`,
            title: 'Save template #' + matchId,
            width: 400, height: 200,
        });
    },

    // ── Joueurs ───────────────────────────────────────────────────────────────

    async getPlayersInfo(matchId) {
        const m      = getMatch(matchId);
        const config = await m.match.getConfig();
        const engines = await tCore.storeGet('engines') || {};
        const engineList = Object.values(engines)
            .filter(e => e.game === m.gameName)
            .map(e => ({ id: e.id, label: e.name }));
        let levels = config.model.levels.map(l => l.label);
        if (m.clock?.mode === 'countdown') levels = ['Auto'];
        return { players: m.getPlayers(), levels, engines: engineList };
    },

    async setPlayers(matchId, players) {
        return matchAction(matchId, async (m) => {
            await m.setPlayers(players);
            await tCore.storeSet('players:' + m.gameName, players);
        });
    },

    // ── Options de vue ────────────────────────────────────────────────────────

    getViewInfo(matchId) {
        const m = getMatch(matchId);
        return m.match.getConfig().then(config => ({
            options: m.viewOptions,
            config:  config.view,
            players: m.getPlayers(),
        }));
    },

    async setViewOptions(matchId, options) {
        return matchAction(matchId, async (m) => {
            await m.setViewOptions(options);
            m.viewOptions = options;
            await tCore.storeSet('view-options:' + m.gameName, options);
        });
    },

    // ── Horloge ───────────────────────────────────────────────────────────────

    async getClock(matchId) {
        const m = getMatch(matchId);
        return { players: m.getPlayers(), clock: m.clock };
    },

    // ── Historique ────────────────────────────────────────────────────────────

    getHistory(matchId)             { return getMatch(matchId).getHistory(); },
    freeze(matchId, index, anim)    { return getMatch(matchId).freeze(index, anim); },

    // ── Coups ─────────────────────────────────────────────────────────────────

    async showMove(matchId, move) { return getMatch(matchId).showMove(move); },

    async inputMove(matchId, move) {
        return matchAction(matchId, m => m.inputMove(move));
    },

    // ── Favoris ───────────────────────────────────────────────────────────────

    async isFavorite(gameName) {
        const favs = await tCore.storeGet('favoriteGames') || {};
        return !!favs[gameName];
    },

    async setFavorite(gameName, favorite) {
        const favs = await tCore.storeGet('favoriteGames') || {};
        if (favorite) favs[gameName] = Date.now();
        else          delete favs[gameName];
        await tCore.storeSet('favoriteGames', favs);
        // Notifier le hub
        tCore.emit('main', 'updateFavorites', favs).catch(() => {});
    },

    // ── Templates ─────────────────────────────────────────────────────────────

    isTemplateNameValid(name) {
        if (!/^[0-9A-Za-z\-_]+$/.test(name)) return false;
        // La vérification d'unicité se fait côté store au moment du save
        return true;
    },

    async saveTemplate(matchId, templateName) {
        const [m, template] = await ctrl.getTemplateData(matchId);
        const templates = await tCore.storeGet('templates') || {};
        template.templateName = templateName;
        m.templateName        = templateName;
        templates[templateName] = template;
        await tCore.storeSet('templates', templates);
        tCore.emit('main', 'updateTemplates', templates).catch(() => {});
    },

    async getTemplateData(matchId) {
        const m    = getMatch(matchId);
        const win  = await WebviewWindowByLabel(m._boardLabel);
        const size = win ? await win.innerSize()     : [700, 600];
        const pos  = win ? await win.outerPosition() : [0, 0];

        const template = {
            gameName:    m.gameName,
            created:     Date.now(),
            lastUsed:    Date.now(),
            players:     m.players,
            clock:       m.originalClock,
            viewOptions: m.viewOptions,
            winSize:     [size.width, size.height],
            winPos:      [pos.x, pos.y],
        };

        // Géométrie des fenêtres satellites
        for (const [key, label] of [
            ['historyWin', m._historyLabel],
            ['clockWin',   m._clockLabel],
            ['movesWin',   m._movesLabel],
        ]) {
            if (label) {
                const w = await WebviewWindowByLabel(label);
                if (w) {
                    const s = await w.innerSize();
                    const p = await w.outerPosition();
                    template[key] = { width: s.width, height: s.height, x: p.x, y: p.y };
                }
            }
        }
        return [m, template];
    },

    async playTemplate(templateName) {
        const templates = await tCore.storeGet('templates') || {};
        const template  = templates[templateName];
        if (!template) throw new Error('No such template: ' + templateName);
        template.lastUsed = Date.now();
        await tCore.storeSet('templates', templates);
        tCore.emit('main', 'updateTemplates', templates).catch(() => {});
        return ctrl.playTemplateData(template);
    },

    async playTemplateData(template, gameData) {
        const m = new JBMatch(template.gameName);
        await m.init(template.clock);
        if (gameData) await m.match.load(gameData);
        await m.setPlayers(template.players);
        matches.set(m.id, m);
        m.viewOptions    = template.viewOptions;
        m.templateName   = template.templateName;
        await m.displayBoard(template.viewOptions, template.winSize ? {
            width: template.winSize[0], height: template.winSize[1],
            x: template.winPos[0],     y: template.winPos[1],
        } : null);
        if (template.historyWin) await m.openHistory(template.historyWin);
        if (template.clockWin)   await m.openClock(template.clockWin);
        if (template.movesWin)   await m.openMoves(template.movesWin);
        m.play().catch(() => {});
        return m.id;
    },

    async removeTemplate(templateName) {
        const templates = await tCore.storeGet('templates') || {};
        if (!templates[templateName]) throw new Error('No such template');
        delete templates[templateName];
        await tCore.storeSet('templates', templates);
        tCore.emit('main', 'updateTemplates', templates).catch(() => {});
    },

    // ── Moteurs ───────────────────────────────────────────────────────────────

    async editEngine(engineId) {
        const engines = await tCore.storeGet('engines') || {};
        let engine;
        if (engineId) {
            engine = engines[engineId];
            if (!engine) throw new Error('No such engine: ' + engineId);
        } else {
            let id = 1;
            while (engines[id]) id++;
            engine = { id: String(id), name: 'Engine ' + id, game: '', type: '', details: '# Yaml format\n\n', lastOpened: Date.now() };
        }
        const encoded = encodeURIComponent(JSON.stringify(engine));
        return tCore.openWindow({
            label: 'engine-' + (engineId || 'new'),
            url:   `content/engine.html?engine=${encoded}`,
            title: engineId ? 'Edit engine' : 'New engine',
            width: 350, height: 570,
            persistKey: 'window:engine',
        });
    },

    async saveEngine(engine) {
        engine.lastOpened = Date.now();
        const engines = await tCore.storeGet('engines') || {};
        engines[engine.id] = engine;
        await tCore.storeSet('engines', engines);
        tCore.emit('main', 'updateEngines', engines).catch(() => {});
    },

    async removeEngine(engineId) {
        const engines = await tCore.storeGet('engines') || {};
        if (!engines[engineId]) throw new Error('No such engine');
        delete engines[engineId];
        await tCore.storeSet('engines', engines);
        tCore.emit('main', 'updateEngines', engines).catch(() => {});
    },

    // ── Board state ───────────────────────────────────────────────────────────

    openBoardState(gameName, matchId) {
        return tCore.openWindow({
            label: 'open-position-' + gameName,
            url:   `content/open-position.html?game=${gameName}&id=${matchId || ''}`,
            title: gameName + ' board state',
            width: 400, height: 150,
        });
    },

    async loadBoardState(gameName, matchId, boardState) {
        const gameData = { game: gameName, playedMoves: [], initialBoard: boardState };
        if (matchId) {
            return matchAction(matchId, m => m.load(gameData));
        } else {
            const m = new JBMatch(gameName);
            await m.init();
            m.players = {
                [Jocly.PLAYER_A]: { type: 'human', name: 'Player A' },
                [Jocly.PLAYER_B]: { type: 'human', name: 'Player B' },
            };
            await m.match.load(gameData);
            m.paused = true;
            matches.set(m.id, m);
            await m.displayBoard();
            await tCore.emit(m._boardLabel, 'display', { gameData });
        }
    },

    async showBoardState(gameName, matchId) {
        const m = getMatch(matchId);
        const boardState = await m.match.getBoardState();
        await tCore.openWindow({
            label: 'show-position-' + gameName + '-' + matchId,
            url:   `content/show-position.html?game=${gameName}&id=${matchId}`,
            title: gameName + ' board state',
            width: 400, height: 150,
            persistKey: 'window:show-position:' + gameName,
        });
        tCore.emit('show-position-' + gameName + '-' + matchId, 'setPosition', boardState);
    },

    // ── Livres PJN ────────────────────────────────────────────────────────────

    async openBook(gameName, fileName, data) {
        const label = 'book-' + gameName;
        await tCore.openWindow({
            label, url: `content/book.html?game=${gameName}&file=${encodeURIComponent(fileName)}`,
            title: gameName + ' Book',
            width: 250, height: 400,
            persistKey: 'window:book:' + gameName,
        });

        // Parser le PJN via la commande Rust (PJNParser.js n'est pas dispo ici)
        try {
            const bookMatches = await tCore.invoke('parse_pjn', { data });
            if (bookMatches.length === 0)
                tCore.emit(label, 'error', 'No game found in this file');
            else
                tCore.emit(label, 'setBookMatches', bookMatches);
        } catch (e) {
            tCore.emit(label, 'error', 'Could not parse file: ' + e.message);
        }
    },

    async openBookMatch(gameName, matchData) {
        const m = new JBMatch(gameName);
        await m.init();
        m.paused  = true;
        m.players = {
            [Jocly.PLAYER_A]: { type: 'human', name: matchData.playerA || 'Player A' },
            [Jocly.PLAYER_B]: { type: 'human', name: matchData.playerB || 'Player B' },
        };
        matches.set(m.id, m);
        await m.displayBoard();

        const histLabel = 'book-history-' + m.id;
        await tCore.openWindow({
            label: histLabel,
            url:   `content/book-history.html?game=${gameName}&id=${m.id}`,
            title: 'Book #' + m.id,
            width: 400, height: 250,
            persistKey: 'window:book-history:' + gameName,
        });
        m._histBookLabel = histLabel;
        tCore.onWindowClose(histLabel, () => { m._histBookLabel = null; });
        await tCore.emit(histLabel, 'setMatchData', matchData);
    },

    async bookHistoryView(matchId, spec) {
        const m = getMatch(matchId);
        const moves = spec.playedMoves.slice(0, spec.playMove ? spec.current + 1 : spec.current);
        return m.loadFromNotation(moves, spec.initial).catch(e => {
            console.error('bookHistoryView error:', e.message);
        });
    },

    // ── Vidéo ─────────────────────────────────────────────────────────────────

    startRecording(matchId) { return getMatch(matchId).startRecording(); },
    stopRecording(matchId)  { return getMatch(matchId).stopRecording(); },
    recordFrame(matchId, f) { return getMatch(matchId).recordFrame(f); },

    // ── Camera ────────────────────────────────────────────────────────────────

    getCamera(matchId)         { return getMatch(matchId).getCamera(); },
    setCamera(matchId, details){ return getMatch(matchId).setCamera(details); },

    // ── Misc ──────────────────────────────────────────────────────────────────

    isFile(path) { return tCore.invoke('is_file', { path }); },

    getAppInfo() {
        return tCore.invoke('get_app_info');
    },
};

// Helper pour récupérer une WebviewWindow par label (API Tauri 2)
async function WebviewWindowByLabel(label) {
    if (!label) return null;
    try { return await WebviewWindow.getByLabel(label); }
    catch { return null; }
}

// ── Écoute des commandes venant de Rust via "controller-call" ─────────────────
//
// Le Rust ne peut pas appeler JS directement. Il émet "controller-call"
// avec { method, args, token } et on répond avec "controller-reply:<token>".
// Cela permet aux commandes Tauri (invoquées par les renderers) de déléguer
// ici sans dupliquer la logique.

export async function startControllerListener() {
    await listen('controller-call', async ({ payload }) => {
        const { method, args, token } = payload;
        try {
            const result = await ctrl[method](...(Array.isArray(args) ? args : [args]));
            await emit('controller-reply:' + token, { result });
        } catch (e) {
            await emit('controller-reply:' + token, { error: e.message });
        }
    });
    console.info('[tabulon-core] controller listener ready');
}

export default ctrl;
