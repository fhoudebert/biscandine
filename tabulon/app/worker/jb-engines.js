// app/worker/jb-engines.js
//
// Portage de joclyboard-engines.js pour environnement WebWorker (sans Node.js).
//
// Différences vs original :
//  - spawn() → Tauri shell plugin via postMessage vers le hub (proxy)
//  - net.Socket → WebSocket ou proxy Tauri
//  - byline → parsing manuel des lignes
//  - js-yaml → import CDN ou bundlé
//
// Les moteurs UCI/CECP/Hub envoient des commandes vers un processus externe.
// Dans Tauri, les processus enfants sont gérés via tauri-plugin-shell (Rust).
// On utilise un pattern proxy : le worker envoie { type:'engine-cmd' } au hub,
// le hub appelle invoke('engine_write'/'engine_read') vers Rust.

// ── Base Engine ───────────────────────────────────────────────────────────────

class Engine {
    init(config) {
        // config.details est déjà parsé (YAML→objet) par le hub avant envoi
        this.config = Object.assign({}, config);
        this.format = 'natural';
    }

    /** Appelé avant chaque coup : synchronise l'état de la partie avec le moteur */
    async catchUp(match) {
        this.match = match;
        this.possibleMoves = await match.getPossibleMoves();
        const strMoves = await match.getMoveString(this.possibleMoves, this.format);
        this.possibleEngineMoves = strMoves;
    }

    /** Résout le meilleur coup à partir de la notation moteur */
    async getBestMove(engineMove) {
        if (this.possibleMoves.length === 1) return this.possibleMoves[0];
        const idx = this.possibleEngineMoves.indexOf(engineMove);
        if (idx >= 0) return this.possibleMoves[idx];
        // Fallback : demander à Jocly de chercher
        console.warn('[Engine] move', engineMove, 'has no exact match, trying pickMove');
        return this.match.pickMove(engineMove);
    }

    async destroy() {}
}

// ── ProcessEngine ─────────────────────────────────────────────────────────────
// Les processus sont gérés côté Rust. Ce code communique via le hub (postMessage).
// Interface : sendToHub({ type:'engine-spawn'|'engine-write'|'engine-kill', ... })

class ProcessEngine extends Engine {
    constructor(sendToHub) {
        super();
        this._sendToHub = sendToHub; // fn(msg) → Promise<response>
        this._inputQueue = [];
        this._waiter     = null;
        this._processId  = null;
    }

    init(config) {
        super.init(config);
    }

    async _ensureProcess() {
        if (this._processId !== null) return;
        const cfg = this.config;
        const args = cfg.details?.args || [];
        const cwd  = cfg.details?.workingDir;
        const resp = await this._sendToHub({
            type: 'engine-spawn',
            binary: cfg.binary,
            args, cwd,
            initialCommands: cfg.details?.initialCommands || [],
        });
        this._processId = resp.processId;
    }

    /** Reçoit une ligne depuis le processus moteur (appelé par le hub) */
    receiveLine(line) {
        if (this.config.details?.debug) console.info(Date.now(), '> ', line);
        if (this._waiter && this._waiter(line)) {
            this._waiter = null;
            return;
        }
        this._inputQueue.push(line);
    }

    /** Attend une ligne correspondant au prédicat fn */
    _wait(fn) {
        return new Promise((resolve, reject) => {
            const tryLine = (line) => {
                try {
                    if (fn(line)) { resolve(); return true; }
                    return false;
                } catch (e) { reject(e); return true; }
            };
            // Vider la queue accumulée
            while (this._inputQueue.length > 0) {
                const line = this._inputQueue.shift();
                if (tryLine(line)) return;
            }
            this._waiter = tryLine;
        });
    }

    async _write(text) {
        if (this.config.details?.debug)
            text.trim().split(/\r?\n/).forEach(l => console.info(Date.now(), '< ', l));
        await this._sendToHub({ type: 'engine-write', processId: this._processId, text });
    }

    async _catchUpStdIO(match, clock) {
        await super.catchUp(match);
        await this._ensureProcess();
    }

    async destroy() {
        if (this._processId !== null) {
            await this._sendToHub({ type: 'engine-kill', processId: this._processId });
            this._processId = null;
        }
        return super.destroy();
    }
}

// ── CECP Engine ───────────────────────────────────────────────────────────────

class CecpEngine extends ProcessEngine {
    init(config) { super.init(config); this.format = 'engine'; }

    async catchUp(match, matchClock) {
        await this._catchUpStdIO(match, matchClock);
        const moves = await match.getPlayedMoves();
        const [engineMoves, turn] = await Promise.all([
            match.getMoveString(moves, 'engine'),
            match.getTurn(),
        ]);
        const [otherTurn, initialBoardState] = await Promise.all([
            match.otherPlayer(turn),
            match.getInitialBoardState('fen'),
        ]);

        const cmds = ['new'];
        if (this.config.details?.variant) cmds.push('variant ' + this.config.details.variant);
        if (initialBoardState) cmds.push('setboard ' + initialBoardState.boardState);
        cmds.push('force');
        (this.config.details?.boardSetup || []).forEach(l => cmds.push(l));
        engineMoves.forEach(m => cmds.push(m));

        const defClock = this.config.details?.defaultClock || 5000;
        let time = defClock, otim = defClock;
        if (matchClock) {
            time = matchClock[turn]      - (Date.now() - matchClock.t0);
            otim = matchClock[otherTurn];
        }
        cmds.push('time ' + Math.floor(Math.max(0, time) / 10));
        cmds.push('otim ' + Math.floor(Math.max(0, otim) / 10));
        cmds.push('go');
        await this._write(cmds.join('\n') + '\n');

        const re = new RegExp(this.config.details?.movePattern || 'move\\s+(\\S+)');
        await this._wait(line => {
            const m = re.exec(line);
            if (m) { this._engineMove = m[1]; return true; }
            return false;
        });
        return this._engineMove;
    }
}

// ── UCI Engine ────────────────────────────────────────────────────────────────

class UciEngine extends ProcessEngine {
    init(config) { super.init(config); this.format = 'engine'; }

    async catchUp(match, matchClock) {
        await this._catchUpStdIO(match, matchClock);
        const moves = await match.getPlayedMoves();
        const [engineMoves, initialBoardState] = await Promise.all([
            match.getMoveString(moves, 'engine'),
            match.getInitialBoardState('fen'),
        ]);
        const [turn, otherTurn] = await Promise.all([match.getTurn(), null]);
        const _turn = await match.getTurn();
        const _other = await match.otherPlayer(_turn);

        const cmds = ['ucinewgame'];
        if (this.config.details?.variant) cmds.push('variant ' + this.config.details.variant);
        (this.config.details?.boardSetup || []).forEach(l => cmds.push(l));

        if (initialBoardState)
            cmds.push('position fen ' + initialBoardState.boardState + ' moves ' + engineMoves.join(' '));
        else
            cmds.push('position startpos moves ' + engineMoves.join(' '));

        const defClock = this.config.details?.defaultClock || 5000;
        let wtime = defClock, btime = defClock;
        if (matchClock) {
            const PLAYER_A = 1, PLAYER_B = -1;
            wtime = matchClock[PLAYER_A] - (matchClock.turn === PLAYER_A ? Date.now() - matchClock.t0 : 0);
            btime = matchClock[PLAYER_B] - (matchClock.turn === PLAYER_B ? Date.now() - matchClock.t0 : 0);
        }
        cmds.push('go wtime ' + Math.max(0, wtime) + ' btime ' + Math.max(0, btime));
        await this._write(cmds.join('\n') + '\n');

        const re = new RegExp(this.config.details?.movePattern || 'bestmove\\s+(\\S+)');
        await this._wait(line => {
            const m = re.exec(line);
            if (m) { this._engineMove = m[1]; return true; }
            return false;
        });
        return this._engineMove;
    }
}

// ── Hub Engine ────────────────────────────────────────────────────────────────

class HubEngine extends ProcessEngine {
    async catchUp(match, matchClock) {
        await this._catchUpStdIO(match, matchClock);
        const moves = await match.getPlayedMoves();
        const [engineMoves, initialBoardState] = await Promise.all([
            match.getMoveString(moves, 'hub'),
            match.getInitialBoardState('hub'),
        ]);

        const cmds = ['start'];
        if (this.config.details?.variant) cmds.push('variant ' + this.config.details.variant);
        if (initialBoardState) cmds.push('pos ' + initialBoardState.boardState);
        engineMoves.forEach(m => cmds.push('move ' + m));

        const defClock = this.config.details?.defaultClock || 5000;
        let clock = defClock;
        if (matchClock?.turn)
            clock = matchClock[matchClock.turn] - (Date.now() - matchClock.t0);
        cmds.push('level 0 ' + Math.max(0, clock) + ' 0');
        cmds.push('go');
        await this._write(cmds.join('\n') + '\n');

        const re = new RegExp(this.config.details?.movePattern || 'move\\s+(\\S+)');
        await this._wait(line => {
            const m = re.exec(line);
            if (m) { this._engineMove = m[1]; return true; }
            return false;
        });

        if (this.config.details?.restart) {
            await this.destroy();
        }

        let move = this._engineMove;
        if (move.includes('x')) {
            const parts = move.split('x');
            const capts = parts.slice(2).sort();
            move = parts.slice(0, 2).concat(capts).join('x');
        }
        return move;
    }
}

// ── DXP Engine ────────────────────────────────────────────────────────────────
// DXP utilise TCP — délégué à Rust via tauri-plugin-shell sidecar ou net plugin.
// Pour l'instant : stub avec TODO.

class DxpEngine extends Engine {
    init(config) {
        super.init(config);
        this._port = config.details?.port || 27531;
        this._host = '127.0.0.1';
    }

    async catchUp(match, matchClock) {
        // TODO Phase 5 : implémenter via WebSocket proxy ou tauri-plugin-net
        throw new Error('DXP engine not yet supported in Tabulon WebWorker mode');
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createEngine(config, sendToHub) {
    let engine;
    switch (config.type) {
        case 'cecp': engine = new CecpEngine(sendToHub); break;
        case 'uci':  engine = new UciEngine(sendToHub);  break;
        case 'hub':  engine = new HubEngine(sendToHub);  break;
        case 'dxp':  engine = new DxpEngine(sendToHub);  break;
        default: throw new Error('Unsupported engine type: ' + config.type);
    }
    engine.init(config);
    return engine;
}
