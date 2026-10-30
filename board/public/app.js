// Board page: lanes from /api/board, per-item threads from /api/thread, and actions sent as events through
// ClaudeSite.send (each wakes Claude). This file renders the page from the app-*.js parts and starts it; load it last.
(function () {
  const B = globalThis.BoardApp;
  const { $, store, state, typing, editing, markSeen } = B;
  const { setHTML, preloadKeys } = BoardUI;

  // Renders open threads from state.threadCache; loadBoard and opening a card load them.
  function render() {
    const d = state.board;
    B.renderHeader(d);
    B.renderWaves(d);
    const live = d.items.filter((i) => !state.withdrawnAsks.has(i.id));
    const shown = state.waveFilter ? live.filter((i) => i.wave === state.waveFilter) : live;
    for (const el of document.querySelectorAll('details.item[open]')) state.openItems.add(el.dataset.key);
    for (const it of d.items) if (!it.isNew) markSeen(it, !state.openItems.has(it.key));
    const html = B.lanesHtml(d, shown);
    if (typing() || editing()) state.lanesStale = true;
    else {
      setHTML($('#lanes'), html);
      state.lanesStale = false;
    }
    for (const key of state.openItems) if (state.threadCache.has(key)) B.renderThread(key, state.threadCache.get(key));
    B.renderNeeds(d);
    B.renderBanner(d);
    B.flashChanged();
  }

  // #item=<wave>/<id> opens that card; push notifications link here, with &reply to land in the thread's reply box
  // (docs/adr/0036-a-push-lands-where-the-owner-answers.md). An ask now in a work item's thread opens that item.
  let focusKey = null;
  let replyKey = null;
  let hashRead = false;
  function readHash() {
    const m = /^#item=([^&]+)(&reply)?$/.exec(location.hash);
    if (!m) return;
    focusKey = decodeURIComponent(m[1]);
    focusKey = state.board?.moved?.[focusKey] || focusKey;
    replyKey = m[2] ? focusKey : null;
    state.openItems.add(focusKey);
    const it = state.board?.items.find((i) => i.key === focusKey);
    if (it) { const s = store.get('lanes', {}); s[it.lane] = true; store.set('lanes', s); }
    if (it?.fold) store.set(B.FOLDS[it.fold].store, true);
  }
  window.addEventListener('hashchange', () => { readHash(); if (state.board) { render(); scrollToFocus(); } });
  // A card link whose hash is already the page's fires no hashchange, so its tap opens the card here.
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest?.('a[href^="#item="]');
    if (!a || a.getAttribute('href') !== location.hash || !state.board) return;
    ev.preventDefault();
    readHash(); render(); scrollToFocus();
  });
  // A card missing from the last visit's board waits for the fresh one, which is final.
  function scrollToFocus(final = true) {
    if (!focusKey) return;
    const el = document.querySelector(`details.item[data-key="${CSS.escape(focusKey)}"]`);
    // The sticky header would cover the card's title row, and its height changes with the safe area.
    if (el) { el.style.scrollMarginTop = `${($('body > .top')?.offsetHeight || 0) + 8}px`; el.scrollIntoView({ block: 'start' }); }
    if (el && replyKey === focusKey) focusReply(replyKey);
    if (el || final) focusKey = replyKey = null;
  }
  // The thread loads after the card opens, so its reply box is waited for, briefly. iOS shows no keyboard for a
  // focus that no tap started, so the box is also brought into view: one tap on it then types.
  function focusReply(key, tries = 20) {
    const ta = document.querySelector(`form[data-reply="${CSS.escape(key)}"] textarea`);
    if (!ta) { if (tries > 0) setTimeout(() => focusReply(key, tries - 1), 150); return; }
    ta.scrollIntoView({ block: 'center' });
    ta.focus({ preventScroll: true });
  }

  // The last visit's board paints dimmed while the first load runs; it doesn't count as landed, so refresh keeps
  // spinning, and the header's time is the snapshot's until a load lands (docs/adr/0028-the-board-opens-on-the-last-visit.md).
  function paintSnapshot() {
    const snap = B.readSnapshot();
    if (!snap) return;
    state.board = snap.board;
    for (const [key, msgs] of Object.entries(snap.threads)) state.threadCache.set(key, msgs);
    state.fresh = { at: snap.savedAt, sig: null };
    B.setView('snapshot');
    readHash();
    hashRead = true;
    render();
    scrollToFocus(false);
    B.holdForFlash();
  }

  // The first load takes over index.html's BoardBoot fetches. Each load fetches the open cards' threads beside the board.
  // via is ui-header.js nextFresh's: a refresh or a change signal fetches every open thread anew rather than share a load
  // that started before the change.
  let boot = globalThis.BoardBoot || null;
  let preloaded = false;
  async function loadBoard({ via = 'poll' } = {}) {
    const started = boot;
    boot = null;
    const threads = [...state.openItems].map((k) => B.loadThread(k, { from: started?.threads.get(k) || null, force: via !== 'poll' }));
    let landed = false;
    try {
      const board = await (started?.board || fetch(ClaudeSite.url('api/board'), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`board ${r.status}`)))));
      const first = state.view !== 'fresh';
      state.board = board;
      B.setView('fresh');
      if (!hashRead || (first && focusKey)) { readHash(); hashRead = true; }
      B.linkUp();
      render();
      scrollToFocus();
      ClaudeSite.syncBadge();
      B.saveSnapshotSoon();
      landed = true;
      if (!preloaded) {
        preloaded = true;
        for (const key of preloadKeys(board.items, state.openItems)) B.loadThread(key);
      }
    } catch (e) {
      B.linkDown();
    }
    await Promise.all(threads);
    if (landed) B.landed(via);
    if (state.view === 'fresh') B.endFlash();
  }

  // The server signals each change to what the board reads, and the page reloads at once; the 30 s poll stays as the
  // fallback and the offline check (docs/adr/0031-the-board-reloads-on-a-change-signal.md). An EventSource retries a
  // dropped stream by itself, but gives up on an answer that isn't a stream, such as the hub's 502 while the server
  // restarts, so a closed one reopens here.
  let stream = null;
  let streamTries = 0;
  let streamOpened = false;
  let reloading = null;
  let reloadAgain = false;
  let signalMissed = false;
  function signalled() {
    if (document.hidden) { signalMissed = true; return; }
    if (reloading) { reloadAgain = true; return; }
    reloading = loadBoard({ via: 'signal' }).finally(() => {
      reloading = null;
      if (reloadAgain) { reloadAgain = false; signalled(); }
    });
  }
  function openStream() {
    if (!('EventSource' in window) || (stream && stream.readyState !== EventSource.CLOSED)) return;
    const es = stream = new EventSource(ClaudeSite.url('api/stream'));
    es.addEventListener('change', signalled);
    // A reopened stream may have missed signals while it was down.
    es.addEventListener('open', () => { streamTries = 0; if (streamOpened) signalled(); streamOpened = true; });
    es.addEventListener('error', () => {
      if (es.readyState !== EventSource.CLOSED || stream !== es) return;
      setTimeout(openStream, Math.min(30000, 1000 * 2 ** streamTries++));
    });
  }

  Object.assign(B, { render, loadBoard });
  paintSnapshot();
  B.headerWired();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    openStream();
    if (signalMissed) { signalMissed = false; signalled(); } else loadBoard();
  });
  window.addEventListener('pageshow', openStream);
  loadBoard();
  openStream();
  setInterval(() => { if (!document.hidden) { loadBoard(); } }, 30000);
})();
