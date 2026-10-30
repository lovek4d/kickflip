// The board view. Each app-*.js file registers a part with BoardView.part((B) => …); BoardView.create(root, site, opts)
// builds one board's B over its root element and its site root (such as '/hub-orchestrator', through ClaudeSite.site),
// and mount() runs the parts in load order, then renders the board from /api/board and per-item threads from
// /api/thread. Actions go out as events through B.site.send (each wakes Claude). Parts add listeners, intervals,
// timers, watches and unmount steps only through B.on, B.every, B.later, B.watch and B.atUnmount, so unmount() undoes
// them all and no board's state outlives its view. BoardView.markup({title}) is the root's inner
// HTML. BoardView.page(root, site, run) gives a board's other views (view-*.js) the same site, $ and recorders.
// opts, both from the app shell (shell.js):
//   signal(fn) → off   calls fn on each change signal for this board, from the hub's one stream
//   live {fresh, generatedAt}
//                      this board was left fresh and hasn't changed since, so a stored last visit whose board has
//                      that generatedAt paints live, with the header time `fresh`, rather than dimmed
// Load this after ui-*.js and attach.js, and before the app-*.js files.
window.BoardView = (function () {
  const parts = [];
  const part = (fn) => { parts.push(fn); };

  // Every board shares the hub's one origin, so each keeps its keys under site:<route>:; app.html's preload reads
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

  // What every view of one site shares: its ClaudeSite.site, a $ and $$ scoped to its root, and the recorders. Each
  // recorder returns a function that undoes what it added, and stop() runs every one still pending, so a view adds
  // listeners, intervals, timers, watches and unmount steps only through them. Before start() and after
  // stop() they add nothing. B.sleep(ms) resolves after ms, and never once the view is gone, so a retry loop stops.
  function base(root, siteRoot) {
    const site = ClaudeSite.site(siteRoot);
    const route = new URL(site.url('')).pathname.replace(/^\/+|\/+$/g, '');
    // attach.js uploads each composer's files to the site of the [data-site] around it.
    root.dataset.site = site.root;
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
    const sleep = (ms) => new Promise((resolve) => { later(ms, resolve); });
    const watch = (fn, opts) => {
      if (!alive) return null;
      const w = site.watch(fn, opts);
      own(() => w.stop());
      return w;
    };
    const atUnmount = (fn) => { if (alive) own(fn); };
    const $ = (s, el = root) => el.querySelector(s);
    const $$ = (s, el = root) => el.querySelectorAll(s);
    const B = { root, site, route, $, $$, on, every, later, sleep, watch, atUnmount, alive: () => alive, own: (off) => (alive ? own(off) : off()) };
    return {
      B,
      start() { alive = true; },
      stop() {
        alive = false;
        for (const off of [...undo]) off();
        undo.clear();
      },
    };
  }

  function create(root, siteRoot, opts = {}) {
    const { B, start: begin, stop } = base(root, siteRoot);
    const store = storeFor(B.route);
    // board is the last /api/board; githubPending the time of a refresh's unanswered check-github request; fresh the
    // header's time, ui-header.js nextFresh's {at, sig}; edits each open edit box by its message's event id,
    // {thread, data, text}, data being what ask-edited sends besides the text.
    const state = {
      board: null,
      fresh: null,
      openItems: new Set(store.get('openItems', [])),
      threadCache: new Map(),
      withdrawnAsks: new Set(),
      edits: new Map(),
      githubPending: null,
      waveFilter: store.get('wave', null),
    };
    const signal = opts.signal ? (fn) => { if (B.alive()) B.own(opts.signal(fn)); } : null;
    Object.assign(B, { store, state, signal, live: opts.live || null });

    function mount() {
      if (B.alive()) return;
      begin();
      for (const p of parts) p(B);
      start(B);
    }
    return { B, mount, unmount: stop };
  }

  // A view other than the board: run(B) adds what it needs through B's recorders when the view mounts.
  // → {B, mount, unmount}
  function page(root, siteRoot, run) {
    const { B, start: begin, stop } = base(root, siteRoot);
    return {
      B,
      mount() { if (B.alive()) return; begin(); run(B); },
      unmount: stop,
    };
  }

  // The board itself, after every part: rendering, the #item= hash, loading and the change signal.
  function start(B) {
    const { $, $$, store, state, keepFocus, markSeen } = B;
    const { setHTML, preloadKeys } = BoardUI;

    // Renders open threads from state.threadCache; loadBoard and opening a card load them.
    function render() {
      const d = state.board;
      const title = $(':scope > .top h1');
      if (d.title && title && title.textContent !== d.title) title.textContent = d.title;
      if (d.title && document.title !== d.title) document.title = d.title;
      B.renderHeader(d);
      B.renderWaves(d);
      const live = d.items.filter((i) => !state.withdrawnAsks.has(i.id));
      const shown = state.waveFilter ? live.filter((i) => i.wave === state.waveFilter) : live;
      for (const el of $$('details.item[open]')) state.openItems.add(el.dataset.key);
      for (const it of d.items) if (!it.isNew) markSeen(it, !state.openItems.has(it.key));
      const html = B.lanesHtml(d, shown);
      // An open card's thread is renderThread's (app-threads.js), so a lane repaint leaves it as it is.
      keepFocus(() => setHTML($('#lanes'), html, { keep: '[data-thread]' }));
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
    // → true when it painted live (B.live), so the controls turn on at once.
    function paintSnapshot() {
      const snap = B.readSnapshot();
      if (!snap) return false;
      const live = Boolean(B.live) && snap.board?.generatedAt === B.live.generatedAt;
      state.board = snap.board;
      for (const [key, msgs] of Object.entries(snap.threads)) state.threadCache.set(key, msgs);
      state.fresh = live ? B.live.fresh : { at: snap.savedAt, sig: null };
      B.setView(live ? 'fresh' : 'snapshot');
      readHash();
      hashRead = true;
      render();
      scrollToFocus(false);
      if (!live) B.holdForFlash();
      return live;
    }

    // The first load takes over app.html's BoardBoot fetches, so only the first view mounted takes them, and only for
    // its own board. Each load fetches the open cards' threads beside the
    // board. via is ui-header.js nextFresh's: a refresh or a change signal fetches every open thread anew rather than
    // share a load that started before the change.
    let boot = globalThis.BoardBoot || null;
    globalThis.BoardBoot = null;
    if (boot?.route && boot.route !== B.route) boot = null;
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

    // The server signals each change to what the board reads, through the shell, and the board reloads at once; the
    // 30 s poll stays as the fallback and the offline check (docs/adr/0031-the-board-reloads-on-a-change-signal.md).
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
    const live = paintSnapshot();
    B.headerWired();
    if (live) B.linkUp();
    B.on(document, 'visibilitychange', () => {
      if (document.hidden) return;
      if (signalMissed) { signalMissed = false; signalled(); } else loadBoard();
    });
    loadBoard();
    B.signal?.(signalled);
    B.every(30000, () => { if (!document.hidden) { loadBoard(); } });
  }

  function markup({ title = '' } = {}) {
    return `${BoardUI.header({ lead: 'logo', title, logoSrc: '/_hub/kickflip.png' })}
<main>
  <section id="setup" class="setup" aria-live="polite" hidden></section>
  <section id="answers" class="answer-banner" hidden></section>
  <section id="waiting" class="waiting" hidden></section>
  <div id="waves" class="waves"></div>
  <div id="lanes"></div>
</main>
<button id="compose" class="fab" type="button" aria-label="New task" title="New task (press n twice)" aria-haspopup="dialog" aria-expanded="false"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
<dialog id="sheet" class="sheet" aria-labelledby="sheetTitle">
  <form id="askForm" data-composer="ask">
    <div class="sheet-head"><h2 id="sheetTitle">New task</h2><button type="button" class="ghost" id="sheetClose" aria-label="Close">✕</button></div>
    <textarea id="askText" rows="4" placeholder="Ask a question or give me a task…" autofocus></textarea>
    <div class="pending-files" data-files></div>
    <div class="row">
      <span class="muted small" id="askStatus"></span>
      <button type="submit" class="primary">Send</button>
    </div>
  </form>
</dialog>
<dialog id="linksSheet" class="sheet" aria-labelledby="linksTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h2 id="linksTitle">Hub links</h2><button type="button" class="ghost" id="linksClose" aria-label="Close">✕</button></div>
    <div id="linksList"></div>
  </div>
</dialog>
<div id="toast" class="toast" role="status" hidden></div>`;
  }

  return { part, create, page, markup };
})();
