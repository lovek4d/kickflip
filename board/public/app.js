// The board view. Each app-*.js file registers a part with BoardView.part((B) => …); BoardView.create(root, site) builds
// one board's B over its root element and its site root (such as '/hub-orchestrator', through ClaudeSite.site), and
// mount() runs the parts in load order, then renders the board from /api/board and per-item threads from /api/thread.
// Actions go out as events through B.site.send (each wakes Claude). Parts add listeners, intervals, timers, streams and
// watches only through B.on, B.every, B.later, B.stream and B.watch, so unmount() undoes them all and no board's state
// outlives its view. Load this after ui-*.js and attach.js, and before the app-*.js files.
window.BoardView = (function () {
  const parts = [];
  const part = (fn) => { parts.push(fn); };

  // Every board shares the hub's one origin, so each keeps its keys under site:<route>:; index.html's preload reads
  // openItems by the same key. Thread and question drafts are already per card and keep their own keys.
  function storeFor(route) {
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
    return {
      get(k, d) { try { const v = localStorage.getItem(keyOf(k)); return v == null ? d : JSON.parse(v); } catch { return d; } },
      set(k, v) { try { localStorage.setItem(keyOf(k), JSON.stringify(v)); } catch {} },
    };
  }

  function create(root, siteRoot) {
    const site = ClaudeSite.site(siteRoot);
    const route = new URL(site.url('')).pathname.replace(/^\/+|\/+$/g, '');
    const store = storeFor(route);
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

    // Each recorder returns a function that undoes what it added; unmount runs every one still pending.
    let alive = false;
    const undo = new Set();
    const own = (off) => { undo.add(off); return () => { undo.delete(off); off(); }; };
    const on = (target, type, fn, opts) => {
      if (!alive || !target) return () => {};
      target.addEventListener(type, fn, opts);
      return own(() => target.removeEventListener(type, fn, opts));
    };
    const every = (ms, fn) => {
      if (!alive) return () => {};
      const t = setInterval(fn, ms);
      return own(() => clearInterval(t));
    };
    const later = (ms, fn) => {
      if (!alive) return () => {};
      const off = () => clearTimeout(t);
      const t = setTimeout(() => { undo.delete(off); fn(); }, ms);
      return own(off);
    };
    const watch = (fn, opts) => {
      if (!alive) return null;
      const w = site.watch(fn, opts);
      own(() => w.stop());
      return w;
    };
    // An EventSource retries a dropped stream by itself, but gives up on an answer that isn't a stream, such as the
    // hub's 502 while the server restarts, so a closed one reopens here with a growing backoff. open() reopens it when
    // it closed; handlers maps event types to listeners.
    function stream(url, handlers) {
      let es = null;
      let tries = 0;
      let retry = () => {};
      const s = {
        open() {
          if (!alive || !('EventSource' in globalThis) || (es && es.readyState !== EventSource.CLOSED)) return;
          retry();
          const cur = es = new EventSource(url);
          cur.addEventListener('open', () => { tries = 0; });
          for (const [type, fn] of Object.entries(handlers)) cur.addEventListener(type, fn);
          cur.addEventListener('error', () => {
            if (cur.readyState !== EventSource.CLOSED || es !== cur) return;
            retry = later(Math.min(30000, 1000 * 2 ** tries++), s.open);
          });
        },
      };
      if (!alive) return s;
      own(() => { retry(); es?.close(); es = null; });
      s.open();
      return s;
    }

    const $ = (s, el = root) => el.querySelector(s);
    const $$ = (s, el = root) => el.querySelectorAll(s);
    const B = { root, site, route, $, $$, store, state, on, every, later, stream, watch };

    function mount() {
      if (alive) return;
      alive = true;
      for (const p of parts) p(B);
      start(B);
    }
    function unmount() {
      alive = false;
      for (const off of [...undo]) off();
      undo.clear();
    }
    return { B, mount, unmount };
  }

  // The board itself, after every part: rendering, the #item= hash, loading and the change signal.
  function start(B) {
    const { $, $$, store, state, typing, editing, markSeen } = B;
    const { setHTML, preloadKeys } = BoardUI;

    // Renders open threads from state.threadCache; loadBoard and opening a card load them.
    function render() {
      const d = state.board;
      B.renderHeader(d);
      B.renderWaves(d);
      const live = d.items.filter((i) => !state.withdrawnAsks.has(i.id));
      const shown = state.waveFilter ? live.filter((i) => i.wave === state.waveFilter) : live;
      for (const el of $$('details.item[open]')) state.openItems.add(el.dataset.key);
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
    B.on(window, 'hashchange', () => { readHash(); if (state.board) { render(); scrollToFocus(); } });
    // A card link whose hash is already the page's fires no hashchange, so its tap opens the card here.
    B.on(B.root, 'click', (ev) => {
      const a = ev.target.closest?.('a[href^="#item="]');
      if (!a || a.getAttribute('href') !== location.hash || !state.board) return;
      ev.preventDefault();
      readHash(); render(); scrollToFocus();
    });
    // A card missing from the last visit's board waits for the fresh one, which is final.
    function scrollToFocus(final = true) {
      if (!focusKey) return;
      const el = $(`details.item[data-key="${CSS.escape(focusKey)}"]`);
      // The sticky header would cover the card's title row, and its height changes with the safe area.
      if (el) { el.style.scrollMarginTop = `${($(':scope > .top')?.offsetHeight || 0) + 8}px`; el.scrollIntoView({ block: 'start' }); }
      if (el && replyKey === focusKey) focusReply(replyKey);
      if (el || final) focusKey = replyKey = null;
    }
    // The thread loads after the card opens, so its reply box is waited for, briefly. iOS shows no keyboard for a
    // focus that no tap started, so the box is also brought into view: one tap on it then types.
    function focusReply(key, tries = 20) {
      const ta = $(`form[data-reply="${CSS.escape(key)}"] textarea`);
      if (!ta) { if (tries > 0) B.later(150, () => focusReply(key, tries - 1)); return; }
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

    // The first load takes over index.html's BoardBoot fetches, which are the page's own board's, so only the first view
    // mounted takes them. Each load fetches the open cards' threads beside the board. via is ui-header.js nextFresh's: a
    // refresh or a change signal fetches every open thread anew rather than share a load that started before the change.
    let boot = globalThis.BoardBoot || null;
    globalThis.BoardBoot = null;
    let preloaded = false;
    async function loadBoard({ via = 'poll' } = {}) {
      const started = boot;
      boot = null;
      const threads = [...state.openItems].map((k) => B.loadThread(k, { from: started?.threads.get(k) || null, force: via !== 'poll' }));
      let landed = false;
      try {
        const board = await (started?.board || fetch(B.site.url('api/board'), { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`board ${r.status}`)))));
        const first = state.view !== 'fresh';
        state.board = board;
        B.setView('fresh');
        if (!hashRead || (first && focusKey)) { readHash(); hashRead = true; }
        B.linkUp();
        render();
        scrollToFocus();
        B.site.syncBadge();
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
    // fallback and the offline check (docs/adr/0031-the-board-reloads-on-a-change-signal.md).
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

    Object.assign(B, { render, loadBoard });
    paintSnapshot();
    B.headerWired();
    let changes = null;
    B.on(document, 'visibilitychange', () => {
      if (document.hidden) return;
      changes?.open();
      if (signalMissed) { signalMissed = false; signalled(); } else loadBoard();
    });
    B.on(window, 'pageshow', () => changes?.open());
    loadBoard();
    // A reopened stream may have missed signals while it was down.
    changes = B.stream(B.site.url('api/stream'), { change: signalled, open: () => { if (streamOpened) signalled(); streamOpened = true; } });
    B.every(30000, () => { if (!document.hidden) { loadBoard(); } });
  }

  return { part, create };
})();
