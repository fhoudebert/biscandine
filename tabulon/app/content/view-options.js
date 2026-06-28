// app/content/view-options.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let viewOptions;

tRpc.listen({});

function supports3D() {
    try {
        return !!window.WebGLRenderingContext &&
               !!document.createElement('canvas').getContext('experimental-webgl');
    } catch { return false; }
}

function FilterSkins(allSkins) {
    return allSkins.filter(skin => supports3D() || !skin['3d']);
}

function UpdateOptions(_viewOptions) {
    viewOptions = _viewOptions;
    const { options, config, players } = _viewOptions;

    const skinSel  = document.querySelector('#skin select');
    const skinWrap = document.getElementById('skin');
    const skins    = FilterSkins(config.skins || []);
    skins.forEach(skin => {
        const opt = document.createElement('option');
        opt.value = skin.name; opt.textContent = skin.title;
        skinSel.appendChild(opt);
    });
    skinWrap.classList.remove('hidden');
    skinSel.value = skins.map(s => s.name).includes(options.skin)
        ? options.skin : (skins[0]?.name);

    const soundsWrap = document.getElementById('sounds');
    soundsWrap.classList.remove('hidden');
    soundsWrap.querySelector('input').checked = !!options.sounds;

    if (config.useNotation) {
        const w = document.getElementById('notation');
        w.classList.remove('hidden');
        w.querySelector('input').checked = !!options.notation;
    }
    if (config.useAutoComplete) {
        const w = document.getElementById('autoComplete');
        w.classList.remove('hidden');
        w.querySelector('input').checked = !!options.autoComplete;
    }
    if (config.useShowMoves) {
        const w = document.getElementById('showMoves');
        w.classList.remove('hidden');
        w.querySelector('input').checked = !!options.showMoves;
    }
    if (config.switchable) {
        const viewAsSel  = document.querySelector('#viewAs select');
        const viewAsWrap = document.getElementById('viewAs');
        [Jocly.PLAYER_A, Jocly.PLAYER_B].forEach(who => {
            const opt = document.createElement('option');
            opt.value = who; opt.textContent = players[who].name;
            viewAsSel.appendChild(opt);
        });
        viewAsWrap.classList.remove('hidden');
        viewAsSel.value = options.viewAs;
    }
    const anaWrap = document.getElementById('anaglyph');
    anaWrap.classList.remove('hidden');
    anaWrap.querySelector('input').checked = !!options.anaglyph;
}

function SetViewOptions() {
    const { config } = viewOptions;
    const options = {
        skin:     document.querySelector('#skin select').value,
        sounds:   document.querySelector('#sounds input').checked,
        anaglyph: document.querySelector('#anaglyph input').checked,
    };
    if (config.useNotation)     options.notation     = document.querySelector('#notation input').checked;
    if (config.useAutoComplete) options.autoComplete = document.querySelector('#autoComplete input').checked;
    if (config.useShowMoves)    options.showMoves    = document.querySelector('#showMoves input').checked;
    if (config.switchable)      options.viewAs       = document.querySelector('#viewAs select').value;

    // Envoyer au worker via la commande Rust set_view_options
    // Le worker mettra à jour le match ET émettra setViewOptions vers play.html
    tRpc.call('set_view_options', matchId, options);
}

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init(`View Options #${matchId}`);

    // Récupérer les infos de vue depuis le worker (via Rust → worker)
    tRpc.call('get_view_info', matchId)
        .then(UpdateOptions)
        .then(() => {
            document.querySelector('.view-options').addEventListener('change', SetViewOptions);
            return twu.ready();
        });

    document.getElementById('button-close').addEventListener('click', () => tRpc.close());
});
