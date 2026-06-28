// app/core/jb-match.js
//
// Port de la classe JBMatch de joclyboard.js.
// Toute la logique métier reste en JS (Jocly est une lib JS, pas Rust).
// Les communications avec les fenêtres renderer se font via tCore.emit()
// qui appelle relay_to_window côté Rust.

import tCore from './tabulon-core.js';

export class JBMatch {

    constructor(gameName) {
        this.id         = tCore.nextMatchId();
        this.gameName   = gameName;
        this.match      = null;
        this.players    = null;
        this.paused     = false;
        this.clock      = null;
        this.originalClock = null;
        this.viewOptions   = null;
        this.templateName  = null;
        this.videoRecorder = null;
        // labels des fenêtres satellites ouvertes
        this._boardLabel   = null;  // "play-<id>"
        this._historyLabel = null;
        this._clockLabel   = null;
        this._movesLabel   = null;
        this._cameraLabel  = null;
        this._playersLabel = null;
        this._viewOptLabel = null;
        this._histBookLabel= null;
        // état interne de la boucle de jeu
        this._actionReject  = null;
        this._actionPromise = null;
        this._nextHumanMove = null;
        this._engines       = {};
        // résolution de fin de vie (appelée à destroy())
        this._endLife = null;
        this.lifePromise = new Promise(resolve => { this._endLife = resolve; });
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    async init(clock) {
        clock = clock || { mode: 'countup', '1': 0, '-1': 0 };
        this.clock         = Object.assign({}, clock);
        this.originalClock = Object.assign({}, clock);

        this.match = await Jocly.createMatch(this.gameName);
        const stored = await tCore.storeGet('view-options:' + this.gameName);
        this.viewOptions = stored || await this.match.getViewOptions();
    }

    // ── Affichage du plateau ──────────────────────────────────────────────────

    async displayBoard(viewOptions, winGeometry) {
        if (this._boardLabel)
            throw new Error('Board already displayed');

        const config = await this.match.getConfig();
        const ratio   = config.view.preferredRatio || 1;
        const maxDim  = 800;
        const width   = Math.min(maxDim, maxDim * ratio);
        const height  = Math.min(maxDim, maxDim / ratio) + 30;

        const label = 'play-' + this.id;
        let   url   = `content/play.html?game=${this.gameName}&id=${this.id}`;
        if (viewOptions)
            url += '&options=' + encodeURIComponent(JSON.stringify(viewOptions));

        const persistKey = winGeometry ? null : ('window:board:' + this.gameName);

        await tCore.openWindow({
            label, url, title: this.gameName + ' #' + this.id,
            width, height,
            minWidth: 300, minHeight: 300,
            persistKey,
            geometry: winGeometry,
        });
        this._boardLabel = label;

        // Quand la fenêtre play se ferme, détruire le match
        tCore.onWindowClose(label, () => {
            this._boardLabel = null;
            this.destroy();
        });
    }

    // ── Boucle de jeu ─────────────────────────────────────────────────────────

    async play() {
        if (this.paused) return;

        const config = await this.match.getConfig();

        // Initialiser les joueurs par défaut si nécessaire
        if (!this.players) {
            this.players = {
                [Jocly.PLAYER_A]: { type: 'human',  name: 'Player A' },
                [Jocly.PLAYER_B]: { type: 'ai:0',   name: 'Player B' },
            };
        }
        // Résoudre les niveaux AI
        for (const which of Object.keys(this.players)) {
            const player = this.players[which];
            const m = /^ai:([0-9]+)/.exec(player.type);
            if (m) player.level = config.model.levels[m[1]];
        }

        if (this._historyBookLabel)
            await tCore.closeWindow(this._historyBookLabel);

        const displayResult = (result) => {
            if      (result.winner === Jocly.PLAYER_A) this._setBoardText(this.players[Jocly.PLAYER_A].name + ' wins');
            else if (result.winner === Jocly.PLAYER_B) this._setBoardText(this.players[Jocly.PLAYER_B].name + ' wins');
            else                                        this._setBoardText('Draw');
        };

        const finished = await this.match.getFinished();
        if (finished.finished) { displayResult(finished); return; }

        if (this._historyLabel)
            tCore.emit(this._historyLabel, 'updateHistory', null);

        const nextMove = async () => {
            const [move, result] = await this._nextMove();
            await this.match.applyMove(move);
            if (this._historyLabel)
                tCore.emit(this._historyLabel, 'updateHistory', null);
            const res = await this.match.getFinished();
            if (res.finished) { displayResult(res); }
            else              { await nextMove(); }
        };

        try { await nextMove(); }
        catch (e) { if (e?.isJBError) console.error('JBMatch.play error:', e.message); }
    }

    async _nextMove() {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        this._actionReject  = reject;
        this._actionPromise = promise;

        try {
            await this._updatePossibleMoves();

            const turn      = await this.match.getTurn();
            const otherTurn = await this.match.otherPlayer(turn);
            const gameData  = await this.match.save();

            // Mise à jour de l'horloge
            if (this.clock && this.clock.turn !== turn) {
                const now = Date.now();
                if (this.clock.turn === otherTurn) {
                    if (this.clock.mode === 'countdown') {
                        this.clock[otherTurn] -= now - this.clock.t0;
                        // temps supplémentaire par coup
                        const xtra = this.clock['xtrasec_' + otherTurn];
                        if (xtra && gameData.playedMoves.length > 0 &&
                            this.clock['last_xtrasec_' + otherTurn] !== gameData.playedMoves.length) {
                            this.clock[otherTurn] += xtra * 1000;
                            this.clock['last_xtrasec_' + otherTurn] = gameData.playedMoves.length;
                        }
                        // session de N coups
                        const mps = this.clock['mps_' + otherTurn];
                        if (mps && gameData.playedMoves.length > 1 &&
                            (Math.floor(gameData.playedMoves.length / 2) % mps) === 0 &&
                            this.clock['last_mps_' + otherTurn] !== gameData.playedMoves.length) {
                            this.clock[otherTurn] += this.originalClock[otherTurn];
                            this.clock['last_mps_' + otherTurn] = gameData.playedMoves.length;
                        }
                    } else {
                        this.clock[otherTurn] += now - this.clock.t0;
                    }
                }
                this.clock.t0   = now;
                this.clock.turn = turn;
                if (this._clockLabel)
                    tCore.emit(this._clockLabel, 'updateClock', null);
            }

            // Afficher le joueur en train de jouer
            const name = this.players[turn]?.name || ('Player ' + turn);
            this._setBoardText(name + ' playing');

            // Déléguer au type de joueur
            const player = this.players[turn];
            let result;
            if      (player.type === 'human')                result = await this._nextMoveHuman(player, gameData);
            else if (/^ai:[0-9]+/.test(player.type))         result = await this._nextMoveAI(player, gameData, turn);
            else if (/^engine:/.test(player.type))           result = await this._nextMoveEngine(player, turn);
            else if (player.type === 'random')               result = await this._nextMoveRandom(gameData);
            else throw new Error('Unknown player type: ' + player.type);

            // Horloge fin de partie
            if (result[1]?.finished) {
                await this._updatePossibleMoves(true);
                if (this.clock?.turn) {
                    const now = Date.now();
                    if (this.clock.mode === 'countdown') this.clock[this.clock.turn] -= now - this.clock.t0;
                    else                                  this.clock[this.clock.turn] += now - this.clock.t0;
                    delete this.clock.turn;
                    if (this._clockLabel) tCore.emit(this._clockLabel, 'updateClock', null);
                }
            }

            resolve(result);
        } catch (e) {
            reject(e);
        }

        this._actionReject  = null;
        this._actionPromise = null;
        return promise;
    }

    async _nextMoveHuman(player, gameData) {
        if (!this._boardLabel) throw new Error('No board window');
        if (this._nextHumanMove) {
            const move = this._nextHumanMove;
            delete this._nextHumanMove;
            const result = await this.match.applyMove(move);
            result.move  = move;
            await this.match.load(gameData);
            await tCore.emit(this._boardLabel, 'display', { gameData });
            return [move, result];
        }
        return tCore.emit(this._boardLabel, 'humanTurn', { gameData });
    }

    async _nextMoveAI(player, gameData, turn) {
        if (!this._boardLabel) throw new Error('No board window');
        let level = player.level;
        if (this.clock?.mode === 'countdown' && level?.ai === 'uct') {
            level = Object.assign({}, level);
            delete level.maxNodes;
            level.maxDuration = (this.clock[turn] / 40) / 1000;
        }
        return tCore.emit(this._boardLabel, 'aiTurn', { gameData, level });
    }

    async _nextMoveRandom(gameData) {
        if (!this._boardLabel) throw new Error('No board window');
        const moves = await this.match.getPossibleMoves();
        if (moves.length === 0) throw new Error('No possible move');
        const move = moves[Math.floor(Math.random() * moves.length)];
        return tCore.emit(this._boardLabel, 'playMove', { gameData, move });
    }

    async _nextMoveEngine(player, turn) {
        if (!this._boardLabel) throw new Error('No board window');
        const engineId = /^engine:(.*)$/.exec(player.type)[1];
        const engines  = await tCore.storeGet('engines') || {};
        const engineCfg = engines[engineId];
        if (!engineCfg) throw new Error('No such engine id ' + engineId);

        if (!this._engines[turn]) {
            // Créer l'engine via commande Rust (spawn process)
            const engineHandle = await tCore.invoke('create_engine', { config: engineCfg });
            this._engines[turn] = engineHandle;
        }

        const engineMove = await tCore.invoke('engine_catch_up', {
            engineId: this._engines[turn],
            matchId: this.id,
            clock: this.clock,
        });
        const move = await tCore.invoke('engine_best_move', {
            engineId: this._engines[turn],
            engineMove,
        });
        const gameData = await this.match.save();
        return tCore.emit(this._boardLabel, 'playMove', { gameData, move });
    }

    // ── Actions interruptibles ────────────────────────────────────────────────

    async _cleanAction() {
        if (this._actionPromise) {
            this._actionReject(new Error('cleanAction: aborted'));
            await this._actionPromise.catch(() => {});
        }
        await this._destroyEngines();
    }

    async _updatePossibleMoves(clear = false) {
        if (!this._movesLabel) return;
        const [moves, strMoves] = clear
            ? [[], []]
            : await Promise.all([
                this.match.getPossibleMoves(),
                this.match.getPossibleMoves().then(m => this.match.getMoveString(m)),
              ]);
        tCore.emit(this._movesLabel, 'updateMoves', { moves, strMoves });
    }

    // ── API publique (appelée par les commandes Rust via invoke) ──────────────

    async takeBack(index) {
        await this._cleanAction();
        await this.pause(false);
        const playedMoves = await this.match.getPlayedMoves();
        if (typeof index !== 'undefined')
            return this.match.rollback(index);
        // Chercher le dernier coup humain
        let lastUserMove = -1;
        const lenOdd  = playedMoves.length % 2 === 1;
        const pA = this.players[Jocly.PLAYER_A].type;
        const pB = this.players[Jocly.PLAYER_B].type;
        if ((lenOdd && pA === 'human') || (!lenOdd && pB === 'human'))
            lastUserMove = playedMoves.length - 1;
        else if ((lenOdd && pB === 'human') || (!lenOdd && pA === 'human'))
            lastUserMove = playedMoves.length - 2;
        if (lastUserMove >= 0) return this.match.rollback(lastUserMove);
        throw new Error('takeBack: no human player');
    }

    async restart() {
        await this._cleanAction();
        if (this.clock) this.clock = Object.assign({}, this.originalClock);
        return this.match.rollback(0);
    }

    async setPlayers(players) {
        await this._cleanAction();
        await this._destroyEngines();
        this.players = players;
    }

    getPlayers() {
        const out = {};
        ['A', 'B'].forEach(w => {
            const p = Jocly['PLAYER_' + w];
            out[p] = {
                type: this.players?.[p]?.type || 'human',
                name: this.players?.[p]?.name || ('Player ' + w),
            };
        });
        return out;
    }

    async load(data) {
        await this._cleanAction();
        return this.match.load(data);
    }

    _setBoardText(text) {
        if (this._boardLabel)
            tCore.emit(this._boardLabel, 'setFooterText', text);
    }

    async setViewOptions(options) {
        await this._cleanAction();
        return tCore.emit(this._boardLabel, 'setViewOptions', options);
    }

    async freeze(index, animLast) {
        await this._cleanAction();
        const gameData = await this.match.save();
        if (animLast) {
            const lastMove  = gameData.playedMoves[index];
            gameData.playedMoves = gameData.playedMoves.slice(0, index);
            await tCore.emit(this._boardLabel, 'display',  { gameData });
            await tCore.emit(this._boardLabel, 'playMove', { gameData, move: lastMove });
            this._setBoardText('');
        } else {
            gameData.playedMoves = gameData.playedMoves.slice(0, index + 1);
            await tCore.emit(this._boardLabel, 'display', { gameData });
            this._setBoardText('');
        }
    }

    async pause(paused) {
        await this._cleanAction();
        if (this.paused !== paused) {
            this.paused = paused;
            if (this.clock) {
                delete this.clock.turn;
                if (this._clockLabel)
                    tCore.emit(this._clockLabel, 'updateClock', null);
            }
        }
    }

    async replayLastMove() {
        await this._cleanAction();
        const gameData = await this.match.save();
        const index    = gameData.playedMoves.length - 1;
        if (index < 0) return;
        const lastMove  = gameData.playedMoves[index];
        gameData.playedMoves = gameData.playedMoves.slice(0, index);
        await tCore.emit(this._boardLabel, 'display',  { gameData });
        await tCore.emit(this._boardLabel, 'playMove', { gameData, move: lastMove });
    }

    async showMove(move) {
        const turn = await this.match.getTurn();
        if (this.players[turn]?.type !== 'human') return;
        await this._cleanAction();
        const gameData = await this.match.save();
        await tCore.emit(this._boardLabel, 'display', { gameData });
        if (move)
            await tCore.emit(this._boardLabel, 'playMove', { gameData, move });
        else
            await this.play();
    }

    async inputMove(move) {
        const turn = await this.match.getTurn();
        if (this.players[turn]?.type !== 'human') return;
        await this._cleanAction();
        this._nextHumanMove = move;
        this.play(); // intentionnellement sans await
    }

    async getHistory() {
        const moves = await this.match.getPlayedMoves();
        return this.match.getMoveString(moves);
    }

    async getCamera() {
        return tCore.invoke(this._boardLabel, 'getCamera', {});
    }

    async setCamera(details) {
        return tCore.emit(this._boardLabel, 'setCamera', details);
    }

    // ── Fenêtres satellites ───────────────────────────────────────────────────

    async openHistory(geometry) {
        const label = 'history-' + this.id;
        if (this._historyLabel) { await tCore.focusWindow(label); return; }
        await tCore.openWindow({
            label, title: 'History #' + this.id,
            url: `content/history.html?game=${this.gameName}&id=${this.id}`,
            width: 400, height: 220,
            persistKey: geometry ? null : ('window:history:' + this.gameName),
            geometry,
        });
        this._historyLabel = label;
        tCore.onWindowClose(label, () => { this._historyLabel = null; });
    }

    async openClock(geometry) {
        const label = 'clock-' + this.id;
        if (this._clockLabel) { await tCore.focusWindow(label); return; }
        await tCore.openWindow({
            label, title: 'Clock #' + this.id,
            url: `content/clock.html?id=${this.id}`,
            width: 400, height: 145, minWidth: 100, minHeight: 25,
            persistKey: geometry ? null : ('window:clock:' + this.gameName),
            geometry,
        });
        this._clockLabel = label;
        tCore.onWindowClose(label, () => { this._clockLabel = null; });
    }

    async openMoves() {
        const label = 'moves-' + this.id;
        if (this._movesLabel) { await tCore.focusWindow(label); return; }
        await tCore.openWindow({
            label, title: 'Possible moves #' + this.id,
            url: `content/moves.html?id=${this.id}`,
            width: 200, height: 350, minWidth: 150,
            persistKey: 'window:moves:' + this.gameName,
        });
        this._movesLabel = label;
        tCore.onWindowClose(label, () => { this._movesLabel = null; });
        await this._updatePossibleMoves();
    }

    async openPlayers() {
        const label = 'players-' + this.id;
        if (this._playersLabel) { await tCore.focusWindow(label); return; }
        await tCore.openWindow({
            label, title: 'Players #' + this.id,
            url: `content/players.html?id=${this.id}`,
            width: 400, height: 240,
        });
        this._playersLabel = label;
        tCore.onWindowClose(label, () => { this._playersLabel = null; });
    }

    async openViewOptions() {
        const label = 'view-options-' + this.id;
        if (this._viewOptLabel) { await tCore.focusWindow(label); return; }
        await tCore.openWindow({
            label, title: 'View Options #' + this.id,
            url: `content/view-options.html?id=${this.id}`,
            width: 280, height: 360,
        });
        this._viewOptLabel = label;
        tCore.onWindowClose(label, () => { this._viewOptLabel = null; });
    }

    async openCameraView() {
        const label = 'camera-' + this.id;
        if (this._cameraLabel) { await tCore.focusWindow(label); return; }
        await tCore.openWindow({
            label, title: 'Camera View #' + this.id,
            url: `content/camera-view.html?game=${this.gameName}&id=${this.id}`,
            width: 400, height: 220,
            persistKey: 'window:camera:' + this.gameName,
        });
        this._cameraLabel = label;
        tCore.onWindowClose(label, () => { this._cameraLabel = null; });
    }

    async loadFromNotation(prettyMoves, initial) {
        await this.match.load({ playedMoves: [], initialBoard: initial });
        let index = 0;
        const step = async () => {
            if (index >= prettyMoves.length) {
                if (this._historyLabel)
                    tCore.emit(this._historyLabel, 'updateHistory', null);
                const gameData = await this.match.save();
                const moves    = gameData.playedMoves;
                const lastMove = moves.length > 0 && moves[moves.length - 1];
                if (lastMove) {
                    const gd2 = { ...gameData, playedMoves: moves.slice(0, -1) };
                    await tCore.emit(this._boardLabel, 'display',  { gameData: gd2 });
                    await tCore.emit(this._boardLabel, 'playMove', { gameData: gd2, move: lastMove });
                } else {
                    await tCore.emit(this._boardLabel, 'display', { gameData });
                }
                return;
            }
            const move = await this.match.pickMove(prettyMoves[index]);
            if (!move) throw new Error('Invalid move: ' + prettyMoves[index]);
            index++;
            await this.match.applyMove(move);
            await step();
        };
        return step();
    }

    // ── Vidéo ─────────────────────────────────────────────────────────────────

    async startRecording() {
        const fileName = await tCore.invoke('dialog_save_file', {
            title: 'Output video file',
            defaultName: this.gameName + '.mp4',
            filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
        });
        if (!fileName) throw new Error('Aborted');
        await tCore.invoke('video_start', { matchId: this.id, fileName });
        this.videoRecorder = true;
    }

    async stopRecording() {
        if (!this.videoRecorder) throw new Error('Not recording');
        this.videoRecorder = false;
        return tCore.invoke('video_stop', { matchId: this.id });
    }

    async recordFrame(frame) {
        if (!this.videoRecorder) throw new Error('Not recording');
        return tCore.invoke('video_frame', { matchId: this.id, frame });
    }

    // ── Destruction ───────────────────────────────────────────────────────────

    async _destroyEngines() {
        for (const id of Object.keys(this._engines)) {
            await tCore.invoke('engine_destroy', { engineId: this._engines[id] }).catch(() => {});
            delete this._engines[id];
        }
    }

    async destroy() {
        // Fermer toutes les fenêtres satellites
        for (const label of [
            this._boardLabel, this._viewOptLabel, this._playersLabel,
            this._historyLabel, this._cameraLabel, this._movesLabel,
            this._clockLabel, this._histBookLabel,
        ]) {
            if (label) await tCore.closeWindow(label).catch(() => {});
        }
        if (this.videoRecorder) await this.stopRecording().catch(() => {});
        await this._destroyEngines();
        this._endLife();
    }
}
