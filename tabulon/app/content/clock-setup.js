// app/content/clock-setup.js
import tRpc  from './tabulon-rpc.js';
import twu   from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();

let selectedPlayer = 0;
let store;

function UpdateSymmetry(symmetry) {
    symmetry = symmetry || document.querySelector('.symmetry').value;
    document.querySelectorAll('.form-group').forEach(el => el.style.display = 'none');
    if (symmetry === 'same') {
        document.querySelectorAll('.form-group.group-same').forEach(el => el.style.display = '');
    } else {
        document.querySelectorAll('.form-group.group-different.player-sel').forEach(el => el.style.display = '');
        document.querySelectorAll('.player-selector').forEach(el => el.classList.remove('highlighted'));
        document.querySelector('.player-selector.player' + selectedPlayer).classList.add('highlighted');
        document.querySelectorAll('.form-group.group-different.player' + selectedPlayer)
            .forEach(el => el.style.display = '');
    }
}

function SetForm(setup) {
    document.querySelector('.symmetry').value = setup.symmetry;
    UpdateSymmetry(setup.symmetry);
    document.querySelector('.group-same input.time').value   = setup.timing.same.value;
    document.querySelector('.group-same select.unit').value  = setup.timing.same.factor;
    document.querySelector('.group-same input.xtrasec').value = setup.timing.same.xtrasec;
    document.querySelector('.group-same input.mps').value    = setup.timing.same.mps;
    [0, 1].forEach((which) => {
        document.querySelector(`.group-different.player${which} input.time`).value    = setup.timing.different[which].value;
        document.querySelector(`.group-different.player${which} select.unit`).value   = setup.timing.different[which].factor;
        document.querySelector(`.group-different.player${which} input.xtrasec`).value = setup.timing.different[which].xtrasec;
        document.querySelector(`.group-different.player${which} input.mps`).value     = setup.timing.different[which].mps;
    });
}

function GetTiming(group) {
    const value = parseInt(group.querySelector('input.time').value);
    if (isNaN(value)) throw new Error('invalid time');
    return 1000 * value * parseInt(group.querySelector('select.unit').value);
}

function GetClock() {
    const clock = { mode: 'countdown' };
    const symmetry = document.querySelector('.symmetry').value;
    try {
        if (symmetry === 'same') {
            const g = document.querySelector('.group-same');
            clock[Jocly.PLAYER_A] = clock[Jocly.PLAYER_B] = GetTiming(g);
            clock['xtrasec_' + Jocly.PLAYER_A] = clock['xtrasec_' + Jocly.PLAYER_B] = parseInt(g.querySelector('input.xtrasec').value) || 0;
            clock['mps_' + Jocly.PLAYER_A]     = clock['mps_' + Jocly.PLAYER_B]     = parseInt(g.querySelector('input.mps').value)    || 0;
        } else {
            [0, 1].forEach((which) => {
                const player = which === 0 ? Jocly.PLAYER_A : Jocly.PLAYER_B;
                const g = document.querySelector(`.group-different.player${which}`);
                clock[player]                  = GetTiming(g);
                clock['xtrasec_' + player]     = parseInt(g.querySelector('input.xtrasec').value) || 0;
                clock['mps_' + player]         = parseInt(g.querySelector('input.mps').value)    || 0;
            });
        }
        return clock;
    } catch (e) { return null; }
}

function OnChange() {
    UpdateSymmetry(document.querySelector('.symmetry').value);
    document.getElementById('button-save').classList.toggle('disabled', !GetClock());
}

document.addEventListener('DOMContentLoaded', async () => {
    store = await Store.load('tabulon.json');

    await Jocly.getGameConfig(gameName)
        .then(config => twu.init(config.model['title-en'] + ' clock setup'));

    document.querySelectorAll('.player-selector').forEach(el => {
        el.addEventListener('click', function () {
            selectedPlayer = this.classList.contains('player0') ? 0 : 1;
            UpdateSymmetry();
        });
    });

    document.getElementById('button-save').addEventListener('click', async () => {
        const clock = GetClock();
        if (!clock) return;
        const sym = document.querySelector('.symmetry').value;
        await store.set('clock', {
            symmetry: sym,
            timing: {
                same: {
                    value:   document.querySelector('.group-same input.time').value,
                    factor:  document.querySelector('.group-same select.unit').value,
                    xtrasec: document.querySelector('.group-same input.xtrasec').value,
                    mps:     document.querySelector('.group-same input.mps').value,
                },
                different: [0, 1].map(which => ({
                    value:   document.querySelector(`.group-different.player${which} input.time`).value,
                    factor:  document.querySelector(`.group-different.player${which} select.unit`).value,
                    xtrasec: document.querySelector(`.group-different.player${which} input.xtrasec`).value,
                    mps:     document.querySelector(`.group-different.player${which} input.mps`).value,
                }))
            }
        });
        await store.save();
        await tRpc.call('new_match', gameName, clock);
        tRpc.close();
    });

    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());

    // Charger les réglages persistés
    const saved = await store.get('clock');
    const setup = Object.assign({
        symmetry: 'same',
        timing: { same: {}, different: [{}, {}] }
    }, saved || {});
    Object.assign(setup.timing.same, { value: 5, factor: 60, xtrasec: 0, mps: 0 }, setup.timing.same);
    [0, 1].forEach(w => {
        setup.timing.different[w] = Object.assign({ value: 5, factor: 60, xtrasec: 0, mps: 0 }, setup.timing.different[w] || {});
    });
    SetForm(setup);

    document.querySelector('.clock-setup-content').addEventListener('change', OnChange);
    document.querySelector('.clock-setup-content').addEventListener('input',  OnChange);
    OnChange();

    twu.ready();
});
