// app/content/clock.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let timers = {}, clock = null;

function TimeFormat(ms) {
    let text = '';
    if (ms < 0) { text += '-'; ms = -ms; }
    const secs  = Math.floor(ms / 1000);
    const mins  = Math.floor(secs / 60) % 60;
    const hours = Math.floor(secs / 3600);
    const s     = secs % 60;
    if (hours > 0) text += hours + ':' + (mins < 10 ? '0' : '');
    text += mins + ':' + (s < 10 ? '0' : '') + s;
    return text;
}

function Update() {
    [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach((which) => {
        let timer;
        if (clock && typeof clock[which] !== 'undefined') {
            let ms = clock[which];
            if (clock.turn === which)
                ms = clock.mode === 'countdown'
                    ? ms - (Date.now() - clock.t0)
                    : ms + (Date.now() - clock.t0);
            timer = TimeFormat(ms);
        } else {
            timer = '--:--';
        }
        if (timer !== timers[which]) {
            timers[which] = timer;
            document.getElementById('clock-time' + which).textContent = timer;
        }
    });
}

function UpdateClock() {
    return tRpc.call('get_clock', matchId)
        .then(({ players, clock: _clock }) => {
            clock = _clock;
            document.querySelectorAll('.players > div, .times > div')
                .forEach(el => el.classList.remove('turn'));
            [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach((which) => {
                document.getElementById('clock-player' + which).textContent = players[which].name;
                if (clock && clock.turn === which) {
                    document.getElementById('clock-player' + which).classList.add('turn');
                    document.getElementById('clock-time'   + which).classList.add('turn');
                }
            });
            Update();
        });
}

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init('Clock #' + matchId);

    [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach((which) => {
        const pd = document.createElement('div');
        pd.id = 'clock-player' + which;
        document.querySelector('.clock .players').appendChild(pd);

        const td = document.createElement('div');
        td.id = 'clock-time' + which;
        document.querySelector('.clock .times').appendChild(td);
    });

    tRpc.listen({ updateClock: UpdateClock });

    UpdateClock().then(() => {
        setInterval(Update, 100);
        twu.ready();
    });
});
