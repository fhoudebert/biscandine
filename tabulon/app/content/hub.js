// app/content/hub.js  —  Fenêtre principale Tabulon
import tRpc       from './tabulon-rpc.js';
import twu        from './tabulon-winutils.js';
import { open, Store, listen } from './tauri-bridge.js';

let store;
let gameList = [], gamesMap = {};
let allGameList = [], favGameList = [], templateList = [], engineList = [];
let filterTimer = null;
let appInfo = { name: 'Tabulon', version: '', homepage: '' };

const defaultFavorites = {
    'classic-chess': 100, 'draughts': 90, 'scrum': 80, 'reversi': 70,
    '9-men-morris': 65, 'fourinarow': 60, 'tafl-hnefatafl': 55,
    'yohoho': 50, 'margo6': 40, 'pensoc': 30,
};

// ── Filtrage ──────────────────────────────────────────────────────────────────
function Filter() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(DoFilter, 200);
}
function DoFilter(q) {
    const str = document.getElementById('gamefilter').value;
    q = q || { title: str, summary: str, module: str };
    document.querySelectorAll('#game-list li.list-group-item').forEach(li => {
        const game = gamesMap[li.dataset.game];
        if (!game) return;
        const show = Object.entries(q).some(([k, v]) =>
            v === '' || (game[k] || '').toLowerCase().includes(v.toLowerCase()));
        li.style.display = show ? '' : 'none';
    });
}

// ── Listes de jeux ────────────────────────────────────────────────────────────
function UpdateGameList() {
    const ul = document.getElementById('game-list');
    ul.querySelectorAll('.list-group-item').forEach(el => el.remove());
    gameList.forEach(game => {
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.dataset.game = game.gameName;
        li.innerHTML = `
            <img class="media-object pull-left" src="${game.thumbnail}" width="48" height="48"/>
            <div class="media-body"><strong>${game.title}</strong><p>${game.summary}</p></div>
            <div title="Quick play" class="media-object pull-right list-shortcut">
                <span class="icon icon-play"></span>
            </div>`;
        li.addEventListener('click', () => tRpc.call('open_game', game.gameName));
        li.querySelector('.list-shortcut').addEventListener('click', (e) => {
            e.stopPropagation();
            tRpc.call('new_match', game.gameName);
        });
        ul.appendChild(li);
    });
}

async function ListGames() {
    const games = await Jocly.listGames();
    gamesMap = games;
    allGameList = Object.keys(games)
        .map(n => ({ gameName: n, ...games[n] }))
        .sort((a, b) => a.title.localeCompare(b.title));

    // Nettoyer les favoris par défaut qui n'existent pas
    for (const g in defaultFavorites)
        if (!gamesMap[g]) delete defaultFavorites[g];

    const navLast = await store.get('nav-last') || 'games-fav';
    document.getElementById('nav-' + navLast)?.click();
}

async function UpdateFavoriteGames(favorites) {
    favorites = favorites || await store.get('favoriteGames') || defaultFavorites;
    favGameList = Object.keys(favorites)
        .map(n => ({ gameName: n, lastSet: favorites[n] || 0, ...gamesMap[n] }))
        .sort((a, b) => b.lastSet - a.lastSet);
}

// ── Templates ─────────────────────────────────────────────────────────────────
async function UpdateTemplates(templates) {
    templates = templates || await store.get('templates') || {};
    templateList = Object.keys(templates)
        .map(n => ({ templateName: n, ...templates[n] }))
        .sort((a, b) => b.lastUsed - a.lastUsed);
}

function UpdateTemplateList() {
    const ul = document.getElementById('template-list');
    ul.querySelectorAll('.list-group-item').forEach(el => el.remove());
    templateList.forEach(template => {
        const game = gamesMap[template.gameName] || {};
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.dataset.template = template.templateName;
        li.innerHTML = `
            <img class="media-object pull-left" src="${game.thumbnail || ''}" width="48" height="48"/>
            <div class="media-body"><strong>${template.templateName}</strong><p>${game.title || ''}</p></div>
            <div title="Remove" class="media-object pull-right list-shortcut list-shortcut-del">
                <span class="icon icon-cancel"></span>
            </div>`;
        li.addEventListener('click', () => tRpc.call('play_template', template.templateName));
        li.querySelector('.list-shortcut').addEventListener('click', (e) => {
            e.stopPropagation();
            tRpc.call('remove_template', template.templateName);
        });
        ul.appendChild(li);
    });
}

// ── Engines ───────────────────────────────────────────────────────────────────
async function UpdateEngines(engines) {
    engines = engines || await store.get('engines') || {};
    engineList = Object.values(engines).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
}

function UpdateEngineList() {
    const ul = document.getElementById('engine-list');
    ul.querySelectorAll('.list-group-item').forEach(el => el.remove());
    engineList.forEach(engine => {
        const game = gamesMap[engine.game] || {};
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.dataset.engine = engine.id;
        li.innerHTML = `
            <img class="media-object pull-left" src="${game.thumbnail || ''}" width="48" height="48"/>
            <div class="media-body"><strong>${engine.name}</strong></div>
            <div title="Remove" class="media-object pull-right list-shortcut list-shortcut-del">
                <span class="icon icon-cancel"></span>
            </div>`;
        li.addEventListener('click', () => tRpc.call('edit_engine', engine.id));
        li.querySelector('.list-shortcut').addEventListener('click', (e) => {
            e.stopPropagation();
            tRpc.call('remove_engine', engine.id);
        });
        ul.appendChild(li);
    });
}

// ── About ─────────────────────────────────────────────────────────────────────
function RenderAbout() {
    document.querySelectorAll('.appName').forEach(el => el.textContent = appInfo.name);
    document.querySelectorAll('.appVersion').forEach(el => el.textContent = appInfo.version);
    const links = {
        '.goto-joclyboard': appInfo.homepage,
        '.goto-jocly':      'https://github.com/mi-g/jocly',
        '.goto-agpl-v3':    'https://www.gnu.org/licenses/agpl-3.0.en.html',
        '.goto-issue':      'https://github.com/mi-g/joclyboard/issues',
    };
    for (const [sel, url] of Object.entries(links)) {
        document.querySelectorAll(sel).forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', (e) => { e.preventDefault(); open(url); });
        });
    }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function SetNav(which) {
    document.querySelectorAll('.sidebar .nav-group-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + which)?.classList.add('active');
    store.set('nav-last', which);
    document.querySelectorAll('.object-pane > .pane').forEach(el => el.style.display = 'none');
}

// ── notifyUser (push depuis Rust) ─────────────────────────────────────────────
// Le Rust émet "notifyUser" + token ; on affiche la bannière et on répond
// via invoke("notify_user_response", { token, result })
listen('notifyUser', ({ payload }) => {
    const { token, text, okText, koText } = payload;
    const notifier = document.querySelector('.hub-notifier');
    document.querySelectorAll('.hub-notifier > *').forEach(el => el.style.display = 'none');

    if (text)   { const el = document.querySelector('.hub-notifier-text'); el.style.display = ''; el.textContent = text; }
    if (okText) {
        const el = document.querySelector('.hub-notifier-ok');
        el.style.display = ''; el.textContent = okText;
        el.onclick = () => { notifier.classList.add('hidden'); tRpc.call('notify_user_response', token, true); el.onclick = null; };
    }
    if (koText) {
        const el = document.querySelector('.hub-notifier-ko');
        el.style.display = ''; el.textContent = koText;
        el.onclick = () => { notifier.classList.add('hidden'); tRpc.call('notify_user_response', token, false); el.onclick = null; };
    }
    notifier.classList.remove('hidden');
});

// Events de mise à jour depuis Rust
tRpc.listen({
    updateFavorites: async (favorites) => {
        await UpdateFavoriteGames(favorites);
        if (await store.get('nav-last') === 'games-fav') { gameList = favGameList; UpdateGameList(); }
    },
    updateTemplates: async (templates) => {
        await UpdateTemplates(templates);
        if (await store.get('nav-last') === 'templates') UpdateTemplateList();
    },
    updateEngines: async (engines) => {
        await UpdateEngines(engines);
        if (await store.get('nav-last') === 'engines') UpdateEngineList();
    },
    // update-available vient du plugin updater
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    console.info('[hub] DOMContentLoaded — start');
    store   = await Store.load('tabulon.json');
    console.info('[hub] store loaded');
    appInfo = await tRpc.call('get_app_info');
    console.info('[hub] app info loaded:', appInfo);

    document.getElementById('nav-games-all').addEventListener('click', async () => {
        SetNav('games-all'); document.getElementById('game-list-pane').style.display = '';
        gameList = allGameList; UpdateGameList();
    });
    document.getElementById('nav-games-fav').addEventListener('click', async () => {
        SetNav('games-fav'); document.getElementById('game-list-pane').style.display = '';
        await UpdateFavoriteGames(); gameList = favGameList; UpdateGameList();
    });
    document.getElementById('nav-templates').addEventListener('click', async () => {
        SetNav('templates'); document.getElementById('template-list').style.display = '';
        await UpdateTemplates(); UpdateTemplateList();
    });
    document.getElementById('nav-engines').addEventListener('click', async () => {
        SetNav('engines'); document.getElementById('engine-list').style.display = '';
        await UpdateEngines(); UpdateEngineList();
    });
    document.getElementById('nav-about').addEventListener('click', () => {
        SetNav('about'); document.getElementById('about').style.display = '';
        RenderAbout();
    });

    document.getElementById('gamefilter').addEventListener('input', Filter);
    document.querySelector('#engine-list .list-group-header')
        .addEventListener('click', () => tRpc.call('edit_engine', null));

    console.info('[hub] calling ListGames()');
    await ListGames();
    console.info('[hub] ListGames() done — allGameList has', allGameList.length, 'games');
    RenderAbout();
    await twu.init(appInfo.name + ' ' + appInfo.version);
    twu.ready();
});
