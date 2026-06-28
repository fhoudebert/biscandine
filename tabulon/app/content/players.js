// app/content/players.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let playerTypes;

function UpdatePlayers(data) {
    playerTypes = [];
    playerTypes.push({ key: 'human',  label: 'Human' });
    playerTypes.push({ key: 'random', label: 'Random' });
    if (data.levels)
        data.levels.forEach((level, index) => {
            playerTypes.push({ key: `ai:${index}`, label: `Jocly - ${level}` });
        });

    ['a', 'b'].forEach((which) => {
        const form   = document.querySelector(`.players-${which}`);
        const player = which === 'a' ? Jocly.PLAYER_A : Jocly.PLAYER_B;
        const select = form.querySelector('select');

        playerTypes.forEach((type) => {
            const opt = document.createElement('option');
            opt.value = type.key;
            opt.textContent = type.label;
            select.appendChild(opt);
        });
        data.engines.forEach((engine) => {
            const opt = document.createElement('option');
            opt.value = `engine:${engine.id}`;
            opt.textContent = engine.label;
            select.appendChild(opt);
        });
        select.value = data.players[player].type;
        form.querySelector('input').value = data.players[player].name || `Player ${which.toUpperCase()}`;
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init(`Players #${matchId}`);

    tRpc.call('get_players_info', matchId)
        .then(UpdatePlayers)
        .then(() => twu.ready());

    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());

    document.getElementById('button-save').addEventListener('click', () => {
        const players = {};
        ['a', 'b'].forEach((which) => {
            const form   = document.querySelector(`.players-${which}`);
            const player = which === 'a' ? Jocly.PLAYER_A : Jocly.PLAYER_B;
            players[player] = {
                type: form.querySelector('select').value,
                name: form.querySelector('input').value,
            };
        });
        tRpc.call('set_players', matchId, players).then(() => tRpc.close());
    });
});
