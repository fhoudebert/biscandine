// app/content/history.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let currentIndex = -1, moveCount = 0;
let playing = false, frozen = false;
let book = [], plyCount = 0;

function btn(action) { return document.querySelector(`.toolbar-actions button[data-action=${action}]`); }

function UpdateButtons() {
    const set = (action, enabled, visibility = false) => {
        const b = btn(action);
        if (!b) return;
        if (visibility) { b.style.display = enabled ? '' : 'none'; }
        else            { b.classList.toggle('disabled', !enabled); }
    };
    set('start',       currentIndex >= 0);
    set('stepback',    currentIndex >= 0);
    set('stepforward', currentIndex < moveCount - 1);
    set('end',         currentIndex < moveCount - 1);
    set('resume',      true);
    set('play',        !playing, true);
    set('pause',        playing, true);
}

function SelectMove(index) {
    document.querySelectorAll('#moves .move').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`#moves .move[data-index="${index}"]`);
    if (el) el.classList.add('active');
    currentIndex = index;
    UpdateButtons();
}

function UpdateHistory(history) {
    frozen    = false;
    moveCount = history.length;
    plyCount  = history.length;
    book      = [];

    const movesElem = document.getElementById('moves');
    movesElem.innerHTML = '';

    history.forEach((move, index) => {
        if (index % 2 === 0) {
            const num = document.createElement('span');
            const text = (index / 2 + 1) + '.';
            num.textContent = text;
            num.className = 'movenumber';
            movesElem.appendChild(num);
            book.push(text);
        }
        const span = document.createElement('span');
        span.setAttribute('data-index', index);
        span.className = 'move';
        span.textContent = move;
        span.addEventListener('click', () => {
            if (index === currentIndex) return;
            frozen = true;
            SelectMove(index);
            tRpc.call('freeze', matchId, index);
        });
        movesElem.appendChild(span);
        book.push(move);
    });

    const container = movesElem.parentElement;
    container.scrollTop = container.scrollHeight;
    SelectMove(moveCount - 1);
    UpdateButtons();
}

function RequestHistory() {
    return tRpc.call('get_history', matchId).then(UpdateHistory);
}

function StartPlaying(animate) {
    playing = true;
    tRpc.call('freeze', matchId, currentIndex, animate)
        .then(() => {
            SelectMove(currentIndex);
            if (playing && currentIndex < moveCount - 1) {
                currentIndex++;
                StartPlaying(true);
            } else {
                playing = false;
                UpdateButtons();
            }
        });
}

function SaveBook() {
    tRpc.call('get_players_info', matchId).then((playersData) => {
        const date = new Date();
        const tags = [
            `[JoclyGame "${gameName}"]`,
            `[Date "${date.getFullYear()}.${date.getMonth()+1}.${date.getDate()}"]`,
            `[White "${playersData.players[Jocly.PLAYER_A].name.replace(/"/g,"'")}"]`,
            `[Black "${playersData.players[Jocly.PLAYER_B].name.replace(/"/g,"'")}"]`,
            `[PlyCount "${plyCount}"]`,
        ];
        const text = tags.join('\n') + '\n\n' + book.join(' ') + '\n';
        const a = document.createElement('a');
        a.href = 'data:application/octet-stream,' + encodeURIComponent(text);
        a.setAttribute('download', gameName + '.pjn');
        a.click();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init('History #' + matchId);

    tRpc.listen({ updateHistory: () => RequestHistory() });

    document.querySelector('[data-action=start]').addEventListener('click', () => {
        frozen = true; SelectMove(-1); tRpc.call('freeze', matchId, -1);
    });
    document.querySelector('[data-action=stepback]').addEventListener('click', () => {
        frozen = true; SelectMove(currentIndex - 1); tRpc.call('freeze', matchId, currentIndex);
    });
    document.querySelector('[data-action=stepforward]').addEventListener('click', () => {
        frozen = true; SelectMove(currentIndex + 1); tRpc.call('freeze', matchId, currentIndex, true);
    });
    document.querySelector('[data-action=end]').addEventListener('click', () => {
        frozen = true; SelectMove(moveCount - 1); tRpc.call('freeze', matchId, currentIndex);
    });
    document.querySelector('[data-action=resume]').addEventListener('click', () => {
        tRpc.call('take_back', matchId, currentIndex + 1);
    });
    document.querySelector('[data-action=position]').addEventListener('click', () => {
        tRpc.call('open_board_state', gameName, matchId);
    });
    document.querySelector('[data-action=showpos]').addEventListener('click', () => {
        tRpc.call('show_board_state', gameName, matchId);
    });
    document.querySelector('[data-action=play]').addEventListener('click',  () => StartPlaying());
    document.querySelector('[data-action=pause]').addEventListener('click', () => { playing = false; });
    document.querySelector('[data-action=save]').addEventListener('click',  () => SaveBook());

    document.getElementById('button-close').addEventListener('click', () => tRpc.close());

    await RequestHistory();
    twu.ready();
});
