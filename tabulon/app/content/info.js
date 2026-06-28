// app/content/info.js
import twu  from './tabulon-winutils.js';
import tRpc from './tabulon-rpc.js';
import { open } from '@tauri-apps/plugin-shell';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();

function TabSelected(what) {
    document.querySelectorAll('.tab-group .tab-item[data-tab]').forEach(el => el.classList.remove('active'));
    document.querySelector(`.tab-group .tab-item[data-tab="${what}"]`)?.classList.add('active');
    document.querySelectorAll('.window-content [data-tab]').forEach(el => el.style.display = 'none');
    document.querySelector(`.window-content [data-tab="${what}"]`)?.style.removeProperty('display');
}

function DefaultTab() {
    for (const t of ['rules', 'description', 'credits']) {
        const tab = document.querySelector(`.tab-group .tab-item[data-tab="${t}"]`);
        if (tab && !tab.classList.contains('hidden')) { TabSelected(t); return; }
    }
}

async function GetHtml(config, what) {
    const descriptor = config.model[what];
    const htmlUrl    = (descriptor && descriptor.en) || descriptor || null;
    if (!htmlUrl) return;

    try {
        // Tauri interdit fetch() vers file:// — on passe par la commande Rust read_text_file
        const fullPath = config.view.fullPath + '/' + htmlUrl;
        const text = await tRpc.call('read_text_file', fullPath);
        const html = text.replace(/\{GAME\}/g, config.view.fullPath);

        const tab     = document.querySelector(`.tab-group .tab-item[data-tab="${what}"]`);
        const content = document.querySelector(`.window-content [data-tab="${what}"]`);
        tab.classList.remove('hidden');
        content.innerHTML = html;

        // Intercepter les liens pour les ouvrir dans le navigateur système
        content.querySelectorAll('a[href]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                open(a.getAttribute('href'));
            });
        });

        DefaultTab();
    } catch (e) {
        console.warn('GetHtml failed for', what, e);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const config = await Jocly.getGameConfig(gameName);
    await twu.init('About ' + config.model['title-en']);

    await Promise.all(['rules', 'description', 'credits'].map(t => GetHtml(config, t)));

    document.querySelectorAll('.tab-group .tab-item[data-tab]').forEach(el => {
        el.addEventListener('click', function () { TabSelected(this.dataset.tab); });
    });
});
