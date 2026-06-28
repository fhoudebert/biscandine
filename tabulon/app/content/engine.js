// app/content/engine.js
import tRpc        from './tabulon-rpc.js';
import twu         from './tabulon-winutils.js';
import { open }    from '@tauri-apps/plugin-shell';

const engineTypes = {
    '':     { label: 'Choose engine type', order: 1, fields: [] },
    'uci':  { label: 'UCI',                order: 2, fields: ['binary', 'details'] },
    'cecp': { label: 'CECP',               order: 3, fields: ['binary', 'details'] },
    'hub':  { label: 'Hub',                order: 4, fields: ['binary', 'details'] },
    'dxp':  { label: 'DXP',               order: 5, fields: ['details'] },
};

const engine = (function () {
    const m = /\?.*\bengine=([^&]+)/.exec(window.location.href);
    try { return m && m[1] && JSON.parse(decodeURIComponent(m[1])) || null; }
    catch { return null; }
})();

function field(name) { return document.getElementById('field-' + name); }

function Validate(name) {
    const value = field(name).value;
    let p;
    switch (name) {
        case 'name':    p = Promise.resolve(value.trim().length > 0); break;
        case 'game':    p = Promise.resolve(value !== ''); break;
        case 'type':    p = Promise.resolve(value !== ''); break;
        case 'binary':  p = tRpc.call('is_file', value); break;
        case 'details':
            try { jsyaml.safeLoad(value); p = Promise.resolve(true); }
            catch { p = Promise.resolve(false); }
            break;
        default: p = Promise.resolve(false);
    }
    return p.then(valid => {
        field(name).classList.toggle('error', !valid);
        return valid;
    });
}

function CheckValidity() {
    document.getElementById('button-save').disabled = true;
    const type   = field('type').value;
    if (!type) return;
    const fields = ['name', 'game', 'type'].concat(engineTypes[type]?.fields || []);
    Promise.all(fields.map(Validate)).then(valids => {
        document.getElementById('button-save').disabled = !valids.every(Boolean);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init('Engine');

    const games = await Jocly.listGames();
    const gameSel = field('game');
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = 'Choose a game';
    gameSel.appendChild(placeholder);
    Object.keys(games).sort((a, b) => games[a].title.localeCompare(games[b].title))
        .forEach(gameName => {
            const opt = document.createElement('option');
            opt.value = gameName;
            opt.textContent = games[gameName].title;
            gameSel.appendChild(opt);
        });

    const typeSel = field('type');
    Object.keys(engineTypes).sort((a, b) => engineTypes[a].order - engineTypes[b].order)
        .forEach(typeKey => {
            const opt = document.createElement('option');
            opt.value = typeKey;
            opt.textContent = engineTypes[typeKey].label;
            typeSel.appendChild(opt);
        });

    // Pré-remplir depuis l'engine passé en paramètre
    if (engine) {
        for (const f in engine)
            if (Object.hasOwn(engine, f) && field(f))
                field(f).value = engine[f];
        (engineTypes[engine.type]?.fields || []).forEach(f => {
            document.getElementById('engine-field-' + f)?.classList.remove('hidden');
        });
    }

    typeSel.addEventListener('change', () => {
        const type = typeSel.value;
        document.querySelectorAll('.engine-field').forEach(el => el.classList.add('hidden'));
        (engineTypes[type]?.fields || []).forEach(f => {
            document.getElementById('engine-field-' + f)?.classList.remove('hidden');
        });
    });

    document.querySelector('.engine-content').addEventListener('change', CheckValidity);
    document.querySelector('.engine-content').addEventListener('input',  CheckValidity);

    document.getElementById('button-cancel').addEventListener('click', () => tRpc.close());

    document.getElementById('button-save').addEventListener('click', async () => {
        const type   = typeSel.value;
        const fields = ['name', 'game', 'type'].concat(engineTypes[type]?.fields || []);
        const eng    = { id: engine?.id };
        fields.forEach(f => { eng[f] = field(f).value; });
        await tRpc.call('save_engine', eng);
        tRpc.close();
    });

    // Lien d'aide
    document.getElementById('help-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        open('https://github.com/mi-g/joclyboard/wiki/Game-Engines');
    });

    twu.ready();
});
