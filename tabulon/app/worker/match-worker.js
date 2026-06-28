// app/worker/match-worker.js
//
// SharedWorker — cœur métier Tabulon.
// Porte la classe JBMatch et le controller de joclyboard.js.
//
// Chaque onglet/fenêtre qui importe ce worker partage le même état.
// hub.js est le seul connecteur ; il relaie les messages vers/depuis
// les autres WebViews via les Tauri events (emit/listen).
//
// Protocol postMessage :
//   hub → worker : { id, type, ...args }
//   worker → hub : { id, result } | { id, error } | { type:'event', event, payload }
//
// Les 'events' sont des notifications asynchrones (humanTurn, updateClock, etc.)
// que le hub relaye vers la WebView cible via tRpc.relay (invoke relay_to_window).

import { createEngine } from './jb-engines.js';

// ── État global ───────────────────────────────────────────────────────────────
let matchesId = 0;
const matches  = {};      // id → JBMatch
let   port     = null;    // MessagePort vers hub.js
let   settings = {};      // clé-valeur (synchronisé avec Tauri store via hub)
let   Jocly    = null;    // lib Jocly — injectée par le hub après chargement

// ── Helpers store ─────────────────────────────────────────────────────────────
function storeGet(key, def) { return key in settings ? settings[key] : def; }
function storeSet(key, val) {
    settings[key] = val;
    emit('store-set', { key, value: val }); // hub persiste dans Tauri store
}

// ── Émettre un event vers hub (asynchrone, sans réponse attendue) ─────────────
function emit(type, payload) {
    port.postMessage({ type: 'event', event: type, payload });
}

// ── Classe JBMatch ────────────────────────────────────────────────────────────

class JBMatch {
    constructor(gameName) {
        this.id       = ++matchesId;
        this.gameName = gameName;
        this.match    = null;
        this.players  = null;
        this.paused   = false;
        this.engines  = {};
        this.clock    = null;
        this.originalClock = null;
        // Fenêtres satellites (labels Tauri)
        this.boardLabel       = `play-${this.id}`;
        this.historyLabel     = null;
        this.clockLabel       = null;
        this.movesLabel       = null;
        this.historyBookLabel = null;
        // Contrôle du cycle de vie
        this._actionAbort = null;
        this._nextHumanMove = null;
    }

    async init(clock) {
        clock = clock || { mode: 'countup', '1': 0, '-1': 0 };
        this.clock = Object.assign({}, clock);
        this.originalClock = Object.assign({}, clock);

        this.match = await Jocly.createMatch(this.gameName);
        const saved = storeGet('view-options:' + this.gameName, null);
        this.viewOptions = saved || await this.match.getViewOptions();
    }

    // ── Lecture config ─────────────────────────────────────────────────────────
    async getConfig() { return this.match.getConfig(); }

    // ── Gestion joueurs ────────────────────────────────────────────────────────
    getPlayers() {
        const p = {};
        for (const which of ['A', 'B']) {
            const key = Jocly['PLAYER_' + which];
            p[key] = {
                type: this.players?.[key]?.type || 'human',
                name: this.players?.[key]?.name || 'Player ' + which,
            };
        }
        return p;
    }

    async setPlayers(players) {
        await this.cleanAction();
        for (const id of Object.keys(this.engines)) {
            await this.engines[id].destroy();
            delete this.engines[id];
        }
        this.players = players;
    }

    // ── Boucle principale ──────────────────────────────────────────────────────
    async play() {
        if (this.paused) return;
        if (!this.players) {
            this.players = {
                [Jocly.PLAYER_A]: { type: 'human',  name: 'Player A' },
                [Jocly.PLAYER_B]: { type: 'ai:0',   name: 'Player B' },
            };
        }

        const config = await this.match.getConfig();
        for (const which of Object.keys(this.players)) {
            const player = this.players[which];
            const m = /^ai:([0-9]+)/.exec(player.type);
            if (m) player.level = config.model.levels[m[1]];
        }

        if (this.historyBookLabel) {
            emit('close-window', { label: this.historyBookLabel });
            this.historyBookLabel = null;
        }

        const displayResult = (result) => {
            if (result.winner === Jocly.PLAYER_A)      this.setBoardText(this.players[Jocly.PLAYER_A].name + ' wins');
            else if (result.winner === Jocly.PLAYER_B)  this.setBoardText(this.players[Jocly.PLAYER_B].name + ' wins');
            else                                         this.setBoardText('Draw');
        };

        if (this.historyLabel) emit('relay', { label: this.historyLabel, event: 'updateHistory', payload: null });

        const finished = await this.match.getFinished();
        if (finished.finished) { displayResult(finished); return; }

        const loop = async () => {
            while (!this.paused) {
                let moveResult;
                try {
                    moveResult = await this.nextMove();
                } catch (e) {
                    if (e?.message?.includes('cleanAction: aborted')) return;
                    console.error('[JBMatch] nextMove error:', e);
                    return;
                }
                const [move, result] = moveResult;
                await this.match.applyMove(move);
                if (this.historyLabel) emit('relay', { label: this.historyLabel, event: 'updateHistory', payload: null });
                if (result.finished) { displayResult(result); return; }
            }
        };
        loop().catch(e => console.warn('[JBMatch] play loop:', e));
    }

    async nextMove() {
        await this.updatePossibleMoves();
        const turn      = await this.match.getTurn();
        const otherTurn = await this.match.otherPlayer(turn);
        const gameData  = await this.match.save();

        // Mise à jour de l'horloge
        if (this.clock && this.clock.turn !== turn) {
            const now = Date.now();
            if (this.clock.turn === otherTurn) {
                if (this.clock.mode === 'countdown') {
                    this.clock[otherTurn] -= now - this.clock.t0;
                    // Extra time per move
                    const xkey = 'xtrasec_' + otherTurn;
                    const lxkey = 'last_xtrasec_' + otherTurn;
                    if (this.clock[xkey] && gameData.playedMoves.length > 0 && this.clock[lxkey] !== gameData.playedMoves.length) {
                        this.clock[otherTurn] += this.clock[xkey] * 1000;
                        this.clock[lxkey] = gameData.playedMoves.length;
                    }
                    // Moves per session
                    const mkey = 'mps_' + otherTurn;
                    const lmkey = 'last_mps_' + otherTurn;
                    if (this.clock[mkey] && gameData.playedMoves.length > 1
                        && (Math.floor(gameData.playedMoves.length / 2) % this.clock[mkey]) === 0
                        && this.clock[lmkey] !== gameData.playedMoves.length) {
                        this.clock[otherTurn] += this.originalClock[otherTurn];
                        this.clock[lmkey] = gameData.playedMoves.length;
                    }
                } else {
                    this.clock[otherTurn] += now - this.clock.t0;
                }
            }
            this.clock.t0   = now;
            this.clock.turn = turn;
            if (this.clockLabel) emit('relay', { label: this.clockLabel, event: 'updateClock', payload: null });
        }

        const name = turn === Jocly.PLAYER_A
            ? this.players[Jocly.PLAYER_A].name
            : this.players[Jocly.PLAYER_B].name;
        this.setBoardText(name + ' playing');

        const player = this.players[turn];
        let result;
        if (player.type === 'human')
            result = await this._nextMoveHuman(player, gameData);
        else if (/^ai:[0-9]+/.test(player.type))
            result = await this._nextMoveAI(player, gameData);
        else if (/^engine:/.test(player.type))
            result = await this._nextMoveEngine(player);
        else if (player.type === 'random')
            result = await this._nextMoveRandom(gameData);
        else
            throw new Error('Unknown player type: ' + player.type);

        // Fin de partie → arrêter l'horloge
        if (result[1]?.finished) {
            await this.updatePossibleMoves(true);
            if (this.clock?.turn) {
                const now = Date.now();
                if (this.clock.mode === 'countdown') this.clock[this.clock.turn] -= now - this.clock.t0;
                else                                  this.clock[this.clock.turn] += now - this.clock.t0;
                delete this.clock.turn;
                if (this.clockLabel) emit('relay', { label: this.clockLabel, event: 'updateClock', payload: null });
            }
        }
        return result;
    }

    // ── Types de joueurs ───────────────────────────────────────────────────────

    async _nextMoveHuman(player, gameData) {
        if (this._nextHumanMove) {
            const move = this._nextHumanMove;
            delete this._nextHumanMove;
            const r = await this.match.applyMove(move);
            await this.match.load(gameData);
            await this._emitToBoard('display', { gameData });
            return [move, Object.assign({ move }, r)];
        }
        return this._waitForBoard('humanTurn', { gameData });
    }

    async _nextMoveAI(player, gameData) {
        let level = player.level;
        if (this.clock?.mode === 'countdown' && level?.ai === 'uct') {
            level = Object.assign({}, level);
            delete level.maxNodes;
            level.maxDuration = (this.clock[this.clock.turn] / 40) / 1000;
        }
        return this._waitForBoard('aiTurn', { gameData, level });
    }

    async _nextMoveRandom(gameData) {
        const moves = await this.match.getPossibleMoves();
        if (moves.length === 0) throw new Error('No possible move');
        const move = moves[Math.floor(Math.random() * moves.length)];
        return this._waitForBoard('playMove', { gameData, move });
    }

    async _nextMoveEngine(player) {
        const engineId = /^engine:(.*)$/.exec(player.type)[1];
        const engines  = storeGet('engines', {});
        const engineCfg = engines[engineId];
        if (!engineCfg) throw new Error('No such engine id ' + engineId);

        const who = await this.match.getTurn();
        if (!this.engines[who]) {
            this.engines[who] = createEngine(engineCfg, msg => this._sendToHub(msg));
        }
        const engineMove = await this.engines[who].catchUp(this.match, this.clock);
        const move       = await this.engines[who].getBestMove(engineMove);
        const gameData   = await this.match.save();
        return this._waitForBoard('playMove', { gameData, move });
    }

    // ── Communication avec la fenêtre play ────────────────────────────────────

    /** Émet un event Tauri vers la fenêtre play et attend la réponse */
    _waitForBoard(event, payload) {
        return new Promise((resolve, reject) => {
            this._actionResolve = resolve;
            this._actionReject  = reject;
            emit('relay', { label: this.boardLabel, event, payload });
        });
    }

    /** Émet sans attendre de réponse */
    _emitToBoard(event, payload) {
        emit('relay', { label: this.boardLabel, event, payload });
        return Promise.resolve();
    }

    /** Appelé quand play.js a terminé un tour (humanTurn/aiTurn/playMove result) */
    resolveAction(result) {
        if (this._actionResolve) {
            const r = this._actionResolve;
            delete this._actionResolve;
            delete this._actionReject;
            r([result.move, result]);
        }
    }

    // ── Actions de contrôle ───────────────────────────────────────────────────

    async cleanAction() {
        if (this._actionReject) {
            const reject = this._actionReject;
            delete this._actionResolve;
            delete this._actionReject;
            reject(new Error('cleanAction: aborted'));
        }
        await this.destroyEngines();
    }

    async takeBack(index) {
        await this.cleanAction();
        this.paused = false;
        const playedMoves = await this.match.getPlayedMoves();
        if (typeof index !== 'undefined') {
            await this.match.rollback(index);
        } else {
            let lastUserMove = -1;
            const pa = this.players[Jocly.PLAYER_A].type, pb = this.players[Jocly.PLAYER_B].type;
            if (((playedMoves.length % 2 === 1) && pa === 'human') || ((playedMoves.length % 2 === 0) && pb === 'human'))
                lastUserMove = playedMoves.length - 1;
            else if (((playedMoves.length % 2 === 1) && pb === 'human') || ((playedMoves.length % 2 === 0) && pa === 'human'))
                lastUserMove = playedMoves.length - 2;
            if (lastUserMove >= 0) await this.match.rollback(lastUserMove);
            else throw new Error('takeBack: no human player');
        }
    }

    async restart() {
        await this.cleanAction();
        if (this.clock) this.clock = Object.assign({}, this.originalClock);
        await this.match.rollback(0);
    }

    async load(data) {
        await this.cleanAction();
        await this.match.load(data);
    }

    async freeze(index, animLast) {
        await this.cleanAction();
        const gameData = await this.match.save();
        if (animLast) {
            const lastMove = gameData.playedMoves[index];
            gameData.playedMoves = gameData.playedMoves.slice(0, index);
            await this._emitToBoard('display', { gameData });
            await this._waitForBoard('playMove', { gameData, move: lastMove });
            this.setBoardText('');
        } else {
            gameData.playedMoves = gameData.playedMoves.slice(0, index + 1);
            await this._emitToBoard('display', { gameData });
            this.setBoardText('');
        }
    }

    async pause(paused) {
        await this.cleanAction();
        if (this.paused !== paused) {
            this.paused = paused;
            if (this.clock) {
                delete this.clock.turn;
                if (this.clockLabel) emit('relay', { label: this.clockLabel, event: 'updateClock', payload: null });
            }
        }
    }

    async replayLastMove() {
        await this.cleanAction();
        const gameData = await this.match.save();
        const index = gameData.playedMoves.length - 1;
        if (index < 0) return;
        const lastMove = gameData.playedMoves[index];
        gameData.playedMoves = gameData.playedMoves.slice(0, index);
        await this._emitToBoard('display', { gameData });
        await this._waitForBoard('playMove', { gameData, move: lastMove });
    }

    async showMove(move) {
        const turn = await this.match.getTurn();
        if (this.players[turn].type !== 'human') return;
        await this.cleanAction();
        const gameData = await this.match.save();
        await this._emitToBoard('display', { gameData });
        if (move) await this._waitForBoard('playMove', { gameData, move });
        else      await this.play();
    }

    async inputMove(move) {
        const turn = await this.match.getTurn();
        if (this.players[turn].type !== 'human') return;
        await this.cleanAction();
        this._nextHumanMove = move;
        this.play();
    }

    async setViewOptions(options) {
        await this.cleanAction();
        emit('relay', { label: this.boardLabel, event: 'setViewOptions', payload: options });
    }

    setBoardText(text) {
        emit('relay', { label: this.boardLabel, event: 'setFooterText', payload: text });
    }

    async getHistory() {
        const moves = await this.match.getPlayedMoves();
        return this.match.getMoveString(moves);
    }

    async updatePossibleMoves(clear) {
        if (!this.movesLabel) return;
        let moves = [], strMoves = [];
        if (!clear) {
            moves     = await this.match.getPossibleMoves();
            strMoves  = await this.match.getMoveString(moves);
        }
        emit('relay', { label: this.movesLabel, event: 'updateMoves', payload: { moves, strMoves } });
    }

    async loadFromNotation(prettyMoves, initial) {
        await this.match.load({ playedMoves: [], initialBoard: initial });
        for (const prettyMove of prettyMoves) {
            const move = await this.match.pickMove(prettyMove);
            if (!move) throw new Error('Invalid move: ' + prettyMove);
            await this.match.applyMove(move);
        }
        if (this.historyLabel) emit('relay', { label: this.historyLabel, event: 'updateHistory', payload: null });
        const gameData = await this.match.save();
        const moves    = gameData.playedMoves;
        if (moves.length > 0) {
            const lastMove = moves[moves.length - 1];
            const partial  = Object.assign({}, gameData, { playedMoves: moves.slice(0, -1) });
            await this._emitToBoard('display', { gameData: partial });
            await this._waitForBoard('playMove', { gameData: partial, move: lastMove });
        } else {
            await this._emitToBoard('display', { gameData });
        }
    }

    // ── Caméra ─────────────────────────────────────────────────────────────────
    async getCamera() {
        return new Promise((resolve, reject) => {
            this._cameraResolve = resolve;
            emit('relay', { label: this.boardLabel, event: 'getCamera', payload: null });
        });
    }

    async setCamera(details) {
        emit('relay', { label: this.boardLabel, event: 'setCamera', payload: details });
    }

    resolveCameraGet(camera) {
        if (this._cameraResolve) { this._cameraResolve(camera); delete this._cameraResolve; }
    }

    // ── Vidéo ──────────────────────────────────────────────────────────────────
    async startRecording() {
        // Délégué à Rust via hub
        emit('start-recording', { matchId: this.id });
    }

    async stopRecording() {
        emit('stop-recording', { matchId: this.id });
    }

    async recordFrame(frame) {
        emit('record-frame', { matchId: this.id, frame });
    }

    // ── Nettoyage ──────────────────────────────────────────────────────────────
    async destroyEngines() {
        await Promise.all(Object.keys(this.engines).map(async id => {
            await this.engines[id].destroy();
            delete this.engines[id];
        }));
    }

    async destroy() {
        for (const label of [this.historyLabel, this.clockLabel, this.movesLabel,
            this.historyBookLabel]) {
            if (label) emit('close-window', { label });
        }
        if (this._videoRecording) await this.stopRecording();
        await this.destroyEngines();
        emit('match-ended', { matchId: this.id });
    }
}

// ── Controller (équivalent du controller de joclyboard.js) ────────────────────

const controller = {

    async newMatch(gameName, clock) {
        const jbm = new JBMatch(gameName);
        await jbm.init(clock);
        matches[jbm.id] = jbm;
        // Ouvrir la fenêtre play via Rust
        emit('open-window', { type: 'play', gameName, matchId: jbm.id, viewOptions: jbm.viewOptions });
        // La fenêtre signalera 'window-ready' → hub appellera startPlay
        return jbm.id;
    },

    startPlay(matchId) {
        const m = matches[matchId];
        if (m) m.play().catch(() => {});
    },

    async newClockedMatch(gameName) {
        emit('open-window', { type: 'clock-setup', gameName });
    },

    async cloneMatch(matchId) {
        const src = matches[matchId];
        if (!src) throw new Error('No such match: ' + matchId);
        const gameData = await src.match.save();
        const template = { gameName: src.gameName, players: src.players,
            clock: src.originalClock, viewOptions: src.viewOptions };
        return controller.playTemplateData(template, gameData);
    },

    async loadMatch(matchId, data) {
        const m = matches[matchId];
        if (!m) throw new Error('No such match');
        return m.load(data);
    },

    async takeBack(matchId, index) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        await m.takeBack(index); m.play().catch(() => {});
    },

    async restart(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        await m.restart(); m.play().catch(() => {});
    },

    async pause(matchId, paused) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        await m.pause(paused); if (!paused) m.play().catch(() => {});
    },

    isPaused(matchId) {
        const m = matches[matchId]; return !!m?.paused;
    },

    async replayLastMove(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        await m.replayLastMove(); m.play().catch(() => {});
    },

    async getHistory(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return m.getHistory();
    },

    async freeze(matchId, index, animLast) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return m.freeze(index, animLast);
    },

    async getPlayersInfo(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        const config     = await m.match.getConfig();
        const engines    = storeGet('engines', {});
        const engineList = Object.values(engines)
            .filter(e => e.game === m.gameName)
            .map(e => ({ id: e.id, label: e.name }));
        let levels = config.model.levels.map(l => l.label);
        if (m.clock?.mode === 'countdown') levels = ['Auto'];
        return { players: m.getPlayers(), levels, engines: engineList };
    },

    async setPlayers(matchId, players) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        await m.setPlayers(players);
        storeSet('players:' + m.gameName, players);
        m.play().catch(() => {});
    },

    async getViewInfo(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        const config = await m.match.getConfig();
        return { options: m.viewOptions, config: config.view, players: m.getPlayers() };
    },

    async setViewOptions(matchId, options) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        await m.setViewOptions(options);
        m.viewOptions = options;
        storeSet('view-options:' + m.gameName, options);
        m.play().catch(() => {});
    },

    getClock(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return { players: m.getPlayers(), clock: m.clock };
    },

    isFavorite(gameName) {
        const favs = storeGet('favoriteGames', {});
        return !!favs[gameName];
    },

    setFavorite(gameName, favorite) {
        const favs = storeGet('favoriteGames', {});
        if (favorite) favs[gameName] = Date.now();
        else          delete favs[gameName];
        storeSet('favoriteGames', favs);
        emit('update-hub', { event: 'updateFavorites', payload: favs });
    },

    async showMove(matchId, move) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return m.showMove(move);
    },

    async inputMove(matchId, move) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return m.inputMove(move);
    },

    // Résultat d'un tour depuis play.js (humanTurn / aiTurn / playMove resolved)
    boardActionResult(matchId, result) {
        const m = matches[matchId];
        if (m) m.resolveAction(result);
    },

    // Résultat getCamera depuis play.js
    boardCameraResult(matchId, camera) {
        const m = matches[matchId];
        if (m) m.resolveCameraGet(camera);
    },

    // ── Satellites ──────────────────────────────────────────────────────────────
    registerSatellite(matchId, type, label) {
        const m = matches[matchId]; if (!m) return;
        switch (type) {
            case 'history':     m.historyLabel     = label; m.updatePossibleMoves(); break;
            case 'clock':       m.clockLabel       = label; break;
            case 'moves':       m.movesLabel       = label; m.updatePossibleMoves(); break;
            case 'historyBook': m.historyBookLabel = label; break;
        }
    },

    unregisterSatellite(matchId, type) {
        const m = matches[matchId]; if (!m) return;
        switch (type) {
            case 'history':     m.historyLabel     = null; break;
            case 'clock':       m.clockLabel       = null; break;
            case 'moves':       m.movesLabel       = null; break;
            case 'historyBook': m.historyBookLabel = null; break;
        }
    },

    // ── Favoris / Templates / Engines ──────────────────────────────────────────
    isTemplateNameValid(name) {
        if (!/^[0-9A-Za-z\-_]+$/.test(name)) return false;
        const templates = storeGet('templates', {});
        return !templates[name];
    },

    async saveTemplate(matchId, templateName) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        const template = {
            gameName: m.gameName, templateName,
            created: Date.now(), lastUsed: Date.now(),
            players: m.players, clock: m.originalClock, viewOptions: m.viewOptions,
        };
        m.templateName = templateName;
        const templates = storeGet('templates', {});
        templates[templateName] = template;
        storeSet('templates', templates);
        emit('update-hub', { event: 'updateTemplates', payload: templates });
    },

    async removeTemplate(templateName) {
        const templates = storeGet('templates', {});
        if (!templates[templateName]) throw new Error('No such template');
        delete templates[templateName];
        storeSet('templates', templates);
        emit('update-hub', { event: 'updateTemplates', payload: templates });
    },

    async playTemplate(templateName) {
        const templates = storeGet('templates', {});
        const template  = templates[templateName];
        if (!template) throw new Error('No such template: ' + templateName);
        template.lastUsed = Date.now();
        storeSet('templates', templates);
        emit('update-hub', { event: 'updateTemplates', payload: templates });
        return controller.playTemplateData(template);
    },

    async playTemplateData(template, gameData) {
        const jbm = new JBMatch(template.gameName);
        await jbm.init(template.clock);
        if (gameData) await jbm.match.load(gameData);
        await jbm.setPlayers(template.players);
        jbm.viewOptions   = template.viewOptions;
        jbm.templateName  = template.templateName;
        matches[jbm.id]   = jbm;
        emit('open-window', { type: 'play', gameName: jbm.gameName, matchId: jbm.id, viewOptions: jbm.viewOptions });
        return jbm.id;
    },

    saveEngine(engine) {
        engine.lastOpened = Date.now();
        const engines = storeGet('engines', {});
        engines[engine.id] = engine;
        storeSet('engines', engines);
        emit('update-hub', { event: 'updateEngines', payload: engines });
    },

    removeEngine(engineId) {
        const engines = storeGet('engines', {});
        if (!engines[engineId]) throw new Error('No such engine');
        delete engines[engineId];
        storeSet('engines', engines);
        emit('update-hub', { event: 'updateEngines', payload: engines });
    },

    // ── Livre / Position ────────────────────────────────────────────────────────
    async openBook(gameName, fileName, data) {
        // Parsing PJN côté worker (PJNParser est disponible via importScripts)
        try {
            const bookMatches = [];
            PJNParser.parse(data, (match) => {
                const fmt = (tags, k) => tags[k] ? /^"*(.*?)"*$/.exec(tags[k])[1] : '?';
                let label = 'Match';
                if (match.tags.White && match.tags.Black) {
                    label = fmt(match.tags, 'White') + ' vs ' + fmt(match.tags, 'Black');
                    if (match.tags.Result && match.tags.Result !== '*') label += ' - ' + match.tags.Result;
                }
                label += ' #' + (bookMatches.length + 1);
                bookMatches.push({
                    label, text: data.substr(match.offset, match.length),
                    playerA: match.tags.White, playerB: match.tags.Black,
                });
            }, () => {
                if (bookMatches.length === 0)
                    emit('book-error', { gameName, error: 'No game found in this file' });
                else
                    emit('book-ready', { gameName, fileName, bookMatches });
            }, (err) => { throw err; });
        } catch (e) {
            emit('book-error', { gameName, error: 'Could not parse file: ' + e.message });
        }
    },

    async openBookMatch(gameName, matchData) {
        const jbm = new JBMatch(gameName);
        await jbm.init();
        jbm.paused = true;
        jbm.players = {
            [Jocly.PLAYER_A]: { type: 'human', name: matchData.playerA || 'Player A' },
            [Jocly.PLAYER_B]: { type: 'human', name: matchData.playerB || 'Player B' },
        };
        matches[jbm.id] = jbm;
        emit('open-window', { type: 'play', gameName, matchId: jbm.id });
        emit('open-book-history', { gameName, matchId: jbm.id, matchData });
    },

    async bookHistoryView(matchId, spec) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        try {
            await m.loadFromNotation(
                spec.playedMoves.slice(0, spec.playMove ? spec.current + 1 : spec.current),
                spec.initial
            );
        } catch (e) {
            emit('error-dialog', { title: 'Error playing book', message: e.message });
        }
    },

    async loadBoardState(gameName, matchId, boardState) {
        const gameData = { game: gameName, playedMoves: [], initialBoard: boardState };
        if (matchId) {
            const m = matches[matchId]; if (!m) throw new Error('No such match');
            await m.load(gameData);
            m.play().catch(() => {});
        } else {
            const jbm = new JBMatch(gameName);
            await jbm.init();
            jbm.players = {
                [Jocly.PLAYER_A]: { type: 'human', name: 'Player A' },
                [Jocly.PLAYER_B]: { type: 'human', name: 'Player B' },
            };
            await jbm.match.load(gameData);
            jbm.paused  = true;
            matches[jbm.id] = jbm;
            emit('open-window', { type: 'play', gameName, matchId: jbm.id });
        }
    },

    async showBoardState(gameName, matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        const boardState = await m.match.getBoardState();
        emit('show-board-state', { gameName, matchId, boardState });
    },

    async getCamera(matchId) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return m.getCamera();
    },

    async setCamera(matchId, details) {
        const m = matches[matchId]; if (!m) throw new Error('No such match');
        return m.setCamera(details);
    },

    // Store sync depuis hub
    syncStore(data) {
        Object.assign(settings, data);
    },

    injectJocly(joclyRef) {
        Jocly = joclyRef;
    }
};

// ── SharedWorker entry point ───────────────────────────────────────────────────

self.onconnect = (e) => {
    port = e.ports[0];
    port.onmessage = async ({ data }) => {
        const { id, type, args = [] } = data;
        if (type === 'inject-jocly') {
            // Le hub envoie la référence Jocly après chargement du script
            // (impossible de passer des objets non-structurés — on importe depuis l'URL)
            importScripts(args[0]); // URL vers jocly.js
            Jocly = self.Jocly;
            port.postMessage({ id, result: true });
            return;
        }
        if (type === 'sync-store') {
            controller.syncStore(args[0]);
            port.postMessage({ id, result: true });
            return;
        }
        const fn = controller[type];
        if (!fn) {
            port.postMessage({ id, error: 'Unknown command: ' + type });
            return;
        }
        try {
            const result = await fn.apply(controller, args);
            port.postMessage({ id, result: result ?? null });
        } catch (e) {
            port.postMessage({ id, error: e.message });
        }
    };
    port.start();
};
