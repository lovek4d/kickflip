// Board page base: the state and helpers the other app-*.js files share through BoardApp. Load it first, after
// ui-*.js and attach.js; app.js loads last and starts the page.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  // Every board shares the hub's one origin, so each keeps its keys under site:<route>:; index.html's preload reads
  // openItems by the same key. Thread and question drafts are already per card and keep their own keys.
  const route = new URL(ClaudeSite.url('')).pathname.replace(/^\/+|\/+$/g, '');
  const keyOf = (k) => (/^(draft:(?!ask$)|qdraft:)/.test(k) ? k : `site:${route}:${k}`);
  // The keys boards kept unprefixed move once, to the first board opened; a key whose new name is taken stays.
  try {
    const old = [];
    for (let i = 0; i < localStorage.length; i++) old.push(localStorage.key(i));
    for (const k of old.filter((k) => /^(openItems|wave|lanes|seenThreads|dismissedAnswers|draft:ask|foldOpen:.+)$/.test(k))) {
      if (localStorage.getItem(keyOf(k)) != null) continue;
      localStorage.setItem(keyOf(k), localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch { /* no storage: nothing to move */ }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(keyOf(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(keyOf(k), JSON.stringify(v)); } catch {} },
  };
  // board is the last /api/board; githubPending the time of a refresh's unanswered check-github request; fresh the
  // header's time, ui-header.js nextFresh's {at, sig}.
  const state = {
    board: null,
    fresh: null,
    openItems: new Set(store.get('openItems', [])),
    threadCache: new Map(),
    withdrawnAsks: new Set(),
    lanesStale: false,
    githubPending: null,
    waveFilter: store.get('wave', null),
  };

  // A rebuild would drop what the reader is typing in a card, so it waits until focus leaves the field.
  const typing = () => $('#lanes').contains(document.activeElement) && document.activeElement.matches('textarea, input:not([type=file])');
  const editing = () => Boolean($('#lanes .edit-form'));
  $('#lanes').addEventListener('focusout', () => setTimeout(() => {
    if (state.lanesStale && state.board && !typing() && !editing()) B.render();
  }));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // A card this browser has never seen starts from now, so a first load badges nothing.
  const seen = store.get('seenThreads', {});
  const latestOf = (it) => [new Date().toISOString(), ...(it?.othersAt || [])].sort().pop();
  function markSeen(it, onlyNew = false) {
    if (!it || (onlyNew && seen[it.key])) return;
    seen[it.key] = latestOf(it);
    store.set('seenThreads', seen);
  }

  // A toast with no ms stays until toast('') clears it, and comes back when a timed toast over it ends.
  let toastTimer = null;
  let sticky = '';
  function toast(html, ms) {
    const t = $('#toast');
    if (!ms) {
      sticky = html;
      if (toastTimer) return;
    } else {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastTimer = null; t.innerHTML = sticky; t.hidden = !sticky; }, ms);
    }
    t.innerHTML = html;
    t.hidden = !html;
  }

  // iOS commits a pending predictive-text word after Send clears the box, which would refill it and resave the draft.
  // So Send blurs first, and input is dropped while the send runs and for a moment after it succeeds.
  const quiet = new Map();
  function quieted(draftKey, ta) {
    const until = quiet.get(draftKey) || 0;
    if (until <= Date.now()) return false;
    if (until !== Infinity) ta.value = '';
    return true;
  }
  async function sendDraft(draftKey, ta, current, send) {
    ta.blur();
    quiet.set(draftKey, Infinity);
    try { await send(); } catch (e) { quiet.delete(draftKey); store.set(draftKey, (current() || ta).value); throw e; }
    store.set(draftKey, '');
    const now = current();
    if (now) now.value = '';
    quiet.set(draftKey, Date.now() + 1000);
  }

  // A deleted ask is hidden on the server, so it leaves every device (docs/adr/0008-dismissals-hide-on-the-server.md).
  const hide = (id, hidden) => fetch(ClaudeSite.url('api/hide'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, hidden }) });
  // The ui-links.js linkContext for text shown on item `key`'s card or thread.
  const links = (key) => BoardUI.linkContext(state.board?.items || [], key);
  const svg = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const { confirm, notice } = globalThis.BoardDialogs;

  const B = globalThis.BoardApp = { $, store, state, typing, editing, plural, seen, markSeen, toast, quieted, sendDraft, hide, links, svg, confirm, notice };
})();
