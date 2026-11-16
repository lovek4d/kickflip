// The board view. Each app-*.js file registers a part with BoardView.part((B) => …); BoardView.create(root, site, opts)
// builds one board's B over its root element and its site root (such as '/hub-orchestrator', through ClaudeSite.site),
// and mount() runs the parts in load order, then renders the board from /api/board and per-item threads from
// /api/thread. Actions go out as events through B.site.send (each wakes Claude). Parts add listeners, intervals,
// timers, watches and unmount steps only through B.on, B.every, B.later, B.watch and B.atUnmount, so unmount() undoes
// them all and no board's state outlives its view but what B.keep keeps for its next mount in this page.
// BoardView.markup({title}) is the root's inner HTML. BoardView.page(root, site, run) gives a board's other views
// (view-*.js) the same site, $ and recorders.
// opts, from the app shell (shell.js):
//   signal(fn) → off   calls fn on each change signal for this board, from the hub's one stream
// Load this after ui-*.js, attach.js and toasts.js, and before the app-*.js files.
window.BoardView = (function () {
  const parts = [];
  const part = (fn) => { parts.push(fn); };
  // route → what a board's view kept as it unmounted, which its next mount in this page reads as B.place. A reload
  // starts with none.
  const places = new Map();

  // Every board shares the hub's one origin, so each keeps its keys under site:<route>:; app.html's preload reads
  // openItems by the same key. Thread and question drafts are already per card and keep their own keys.
  function storeFor(route) {
    const keyOf = (k) => (/^(draft:(?!ask$)|qdraft:)/.test(k) ? k : `site:${route}:${k}`);
    // The keys boards kept unprefixed move once, to the first board opened; a key whose new name is taken stays.
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i++) old.push(localStorage.key(i));
      // Read marks moved to the board (docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md), so this browser's old copies go.
      for (const k of old.filter((k) => /^(site:[\w-]+:)?(seenThreads|dismissedAnswers)$/.test(k))) localStorage.removeItem(k);
      // The saved copy moved to IndexedDB (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md).
      for (const k of old.filter((k) => k === 'boardSnapshots' || k.startsWith('boardSnapshot:'))) localStorage.removeItem(k);
      for (const k of old.filter((k) => /^(openItems|wave|lanes|draft:ask|foldOpen:.+)$/.test(k))) {
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
    let toasts = null;
    const toast = (text) => {
      if (!alive) return;
      if (!toasts) {
        toasts = BoardToasts.create(root);
        own(() => { toasts.destroy(); toasts = null; });
      }
      toasts.toast(text);
    };
    const store = storeFor(route);
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
    const B = { root, site, route, store, quieted, sendDraft, toast, $, $$, on, every, later, sleep, watch, atUnmount, alive: () => alive, own: (off) => (alive ? own(off) : off()) };
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
    const { store } = B;
    // board is the last /api/board; fresh the
    // header's time, ui-header.js nextFresh's {at, sig}; edits each New strip ask's open edit box by its ask's
    // event id, {key, data, text}, key its card's and data what ask-edited sends besides the text.
    const state = {
      board: null,
      fresh: null,
      openItems: new Set(store.get('openItems', [])),
      // The cards open when the page loaded: Done hides those past their cap until the owner opens one this visit.
      restored: new Set(store.get('openItems', [])),
      threadCache: new Map(),
      // Each card's notes by key, which the board's sync keeps (app-reader.js takeNotes, fillNotes).
      notesCache: new Map(),
      edits: new Map(),
      // Main's refresh icon (ui-cards.js mainPull): a tap waiting on the server, and the failed pull's reason open on touch.
      mainPull: { open: false },
      // The Done cards Show more paged in from the archive past the board's own (app-lanes.js), and how many older ones
      // the archive holds past them, null before the first page.
      archived: { cards: [], left: null },
    };
    const signal = opts.signal ? (fn) => { if (B.alive()) B.own(opts.signal(fn)); } : null;
    // B.keep(fn): a part adds fn() → {…} to what the board keeps as it unmounts, read before any part's unmount step.
    const keepers = [];
    const keep = (fn) => { if (B.alive()) keepers.push(fn); };
    const place = places.get(B.route) || null;
    places.delete(B.route);
    Object.assign(B, { store, state, signal, pause: opts.pause, away: opts.away, place, keep });

    function mount() {
      if (B.alive()) return;
      begin();
      for (const p of parts) p(B);
      start(B);
    }
    function unmount() {
      if (B.alive()) places.set(B.route, Object.assign({}, ...keepers.map((fn) => fn())));
      keepers.length = 0;
      stop();
    }
    return { B, mount, unmount };
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

  // The board itself, after every part: rendering, the URL fragment, loading and the change signal.
  function start(B) {
    const { $, $$, store, state, steady, markSeen } = B;
    const { setHTML } = BoardUI;

    // The spinUntil taps waiting for their change to show.
    const showing = new Set();
    // Renders open threads from state.threadCache, which the board's sync fills (app-threads.js takeThreads, fillThreads).
    function render(load = null) {
      const d = state.board;
      // The cards as the outbox's Done taps have them (ui-snapshot.js tapped), the lanes and strips drawing from these.
      const items = BoardUI.tapped(d.items, store.get('outbox', []));
      drawnDone = items.filter((i, n) => i !== d.items[n]).map((i) => i.key).join();
      const title = $(':scope > .top h1');
      if (d.title && title && title.textContent !== d.title) title.textContent = d.title;
      if (d.title && document.title !== d.title) document.title = d.title;
      steady(() => {
        B.renderHeader(d);
        B.renderArch(d);
        B.renderWaits(d);
        BoardUI.setHTML($('#tryMain'), BoardUI.mainBar(d.main, state.mainPull));
        B.renderMainLog(d.main, load);
        for (const el of $$('details.item[open]')) state.openItems.add(el.dataset.key);
        B.takeMarks(d.items);
        for (const it of d.items) if (state.openItems.has(it.key)) markSeen(it);
        // An open card's thread is renderThread's (app-threads.js), so a lane repaint leaves it as it is.
        const strips = B.captureStrips();
        setHTML($('#lanes'), B.lanesHtml(d, items), { keep: '[data-thread]' });
        $('.board-foot').hidden = false;
        for (const key of state.openItems) if (state.threadCache.has(key)) B.renderThread(key, state.threadCache.get(key));
        B.moveStrips(items, strips);
        B.renderPane(d);
        B.renderBanner(d);
        B.renderNew(d);
      });
      B.flashChanged();
      B.signCards(load);
      checkShown();
    }

    // A Done entering or leaving the outbox redraws the lanes at once, the card in Done or, refused, back where it was.
    const doneTaps = () => BoardUI.tapped(state.board.items, store.get('outbox', [])).filter((i, n) => i !== state.board.items[n]).map((i) => i.key).join();
    let drawnDone = '';
    B.atUnmount(BoardUI.onOutbox(() => {
      if (!state.board) return;
      const now = doneTaps();
      if (now === drawnDone) return;
      drawnDone = now;
      render();
    }));

    // #review=<PR number> opens that review in the Auto Review lane (app-lanes.js openReview), as a held review's push does.
    // #selectedCard=<file>/<id> (or the older #item=) opens that card, and &openItemsCard=<topic id> opens that pill in the pane; push notifications link here, with &reply to land in the thread's reply box
    // (docs/adr/2026-10-29-1639-a-push-lands-where-the-owner-answers.md). An ask now in a work item's thread opens that item.
    let focusKey = null;
    let replyKey = null;
    let hashRead = false;
    // A board this page left goes back to where the owner left it once it first renders, unless its URL names a card.
    const returnToPlace = () => B.restorePlace({ linked: /^#(?:selectedCard|item|review)=/.test(location.hash) });
    // The pane's pill the fragment names opens once the pane has loaded (app-selection.js replayTopic); a phone has no
    // pane, its pill is the Waiting on you page (shell.js go). pill: false when the caller has just set the pill itself.
    function readHash({ pill = true } = {}) {
      const { selectedCard, openItemsCard, review, reply } = AppRouter.fragmentOf(location.hash);
      if (review && state.board) { B.openReview(review); return; }
      if (pill) B.replayTopic(openItemsCard);
      if (!selectedCard) return;
      focusKey = BoardUI.record(state.board?.moved, selectedCard) || selectedCard;
      replyKey = reply ? focusKey : null;
      state.openItems.add(focusKey);
      state.restored.delete(focusKey);
      const it = state.board?.items.find((i) => i.key === focusKey);
      if (it) { const s = store.get('lanes', {}); s[it.lane] = true; store.set('lanes', s); }
    }
    // The owner's own moves rewrite the fragment in place, with no history entry and no hashchange.
    B.saveFragment = (changes) => {
      const hash = AppRouter.hashWith(location.hash, changes);
      if (hash !== location.hash) history.replaceState(history.state, '', location.pathname + location.search + hash);
    };
    // Hidden while its Waiting on you shows on a phone (shell.js show), the address is that page's.
    B.on(window, 'hashchange', () => { if (B.root.hidden) return; readHash(); if (state.board) { render(); scrollToFocus(); } });
    // A card link whose hash is already the page's fires no hashchange, so its tap opens the card here.
    B.on(B.root, 'click', (ev) => {
      const a = ev.target.closest?.('a[href^="#item="], a[href^="#selectedCard="]');
      if (!a || ev.defaultPrevented || a.getAttribute('href') !== location.hash || !state.board) return;
      ev.preventDefault();
      readHash(); render(); scrollToFocus();
    });
    // Opens and scrolls to the card key on the board, the fragment's changes set in the same write → whether the board
    // shows it. The write replaces the page's entry: a pick adds none.
    function focusOnBoard({ key, changes }) {
      if (!state.board?.items.some((i) => i.key === key)) return false;
      B.saveFragment(changes);
      readHash({ pill: false });
      render();
      scrollToFocus();
      return true;
    }
    // A card missing from the last visit's board waits for the fresh one, which is final.
    function scrollToFocus(final = true) {
      if (!focusKey) return;
      const el = $(`details.item[data-key="${CSS.escape(focusKey)}"]`);
      // The desktop header, or below 900px the status bar, would cover the card's title row.
      if (el) {
        el.style.scrollMarginTop = matchMedia('(min-width: 900px)').matches
          ? `${($(':scope > .top')?.offsetHeight || 0) + 8}px` : 'calc(env(safe-area-inset-top) + 8px)';
        el.scrollIntoView({ block: 'start' });
      }
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

    // The saved copy paints live before the first load, which asks only for the changes since its number; the lines
    // that catch-up changes flash (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md). A board that landed
    // meanwhile stays.
    // old: a copy another build saved, whose board the next load asks for whole.
    function paintCopy(copy, { old = false } = {}) {
      if (!copy || !B.alive() || state.view === 'fresh') return;
      state.oldCopy = old;
      state.board = copy.board;
      for (const [key, msgs] of Object.entries(copy.threads)) state.threadCache.set(key, msgs);
      for (const [key, notes] of Object.entries(copy.notes)) state.notesCache.set(key, notes);
      state.fresh = { at: copy.savedAt, sig: null };
      B.setView('fresh');
      readHash();
      hashRead = true;
      render();
      scrollToFocus(false);
      returnToPlace();
      B.holdForFlash();
      B.linkUp();
    }

    // The first load takes over app.html's BoardBoot fetches, so only the first view mounted takes them, and only for
    // its own board. A load with no board on screen to patch gets a whole board, which carries no threads, so it fetches
    // the open cards' threads beside it; a patch carries the threads that changed
    // (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md). via is ui-header.js nextFresh's: a refresh or a change
    // signal fetches every open thread anew rather than share a load that started before the change.
    let boot = globalThis.BoardBoot || null;
    globalThis.BoardBoot = null;
    if (boot?.route && boot.route !== B.route) boot = null;
    // The open cards' loads of the last land's fillThreads, which the load that landed the board waits for.
    let filling = Promise.resolve();
    // A load nothing answers gives up after this, so an asleep host reads as out of reach.
    const LOAD_TIMEOUT = 20000;
    // A failed answer, carried to showDown for BoardUI.downOf.
    const unanswered = (r) => Object.assign(new Error(`board ${r.status}`), { answer: r });
    async function loadBoard({ via = 'poll' } = {}) {
      const load = B.boardLoad = (B.boardLoad || 0) + 1;
      const started = boot;
      boot = null;
      // A reload names the change number of the board on screen: an unchanged board answers 304 with no body
      // (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md), and a changed one a patch of what
      // changed after it (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md).
      const tag = state.view === 'fresh' && !state.oldCopy ? state.board.version : null;
      // The open threads draw once this load's board has landed or failed (app-threads.js loadThread's after).
      let boardIn;
      const after = new Promise((resolve) => { boardIn = resolve; });
      const threads = tag ? [] : [...state.openItems].map((k) => B.loadThread(k, { from: started?.threads.get(k) || null, force: via !== 'poll', after }));
      let landed = false;
      try {
        const timeout = new AbortController();
        const stopTimer = B.later(LOAD_TIMEOUT, () => timeout.abort());
        const board = await (started?.board || fetch(B.site.url('api/board' + (tag ? '?since=' + encodeURIComponent(tag) : '')), { cache: 'no-store', signal: timeout.signal, ...(tag ? { headers: { 'if-none-match': `"${tag}"` } } : {}) })
          .then((r) => (r.status === 304 ? null : r.ok ? r.json().catch(() => { throw unanswered(r); }) : Promise.reject(unanswered(r))))
          .finally(stopTimer));
        if (board && land(board, load)) threads.push(filling);
        else if (!board) B.linkUp();
        boardIn();
        landed = true;
      } catch (e) {
        boardIn();
        B.linkDown();
        if (state.view !== 'fresh' && B.alive()) await showDown(BoardUI.downOf(e.answer || null));
      }
      await Promise.all(threads);
      if (landed) B.landed(via);
      if (state.view === 'fresh') B.endFlash();
    }

    // A board out of reach with nothing on screen paints the copy another build saved, which the first paint skipped,
    // guarded: a paint that throws leaves the landing, the kickflip mark and down's two lines in the board's place, and
    // the landing retries every 5 s while the board can come back by itself
    // (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
    let triedOldCopy = false;
    async function showDown(down) {
      if (!triedOldCopy) {
        triedOldCopy = true;
        const old = await B.readCopy({ anyBuild: true });
        try { paintCopy(old, { old: true }); } catch {
          state.board = null;
          B.setView(null);
        }
        if (!B.alive()) return;
        if (state.view === 'fresh') { B.linkDown(); return; }
      }
      state.down = down;
      $('#downLanding').innerHTML = BoardUI.downLanding(down);
      $('#downLanding').hidden = false;
      B.root.classList.add('down');
    }
    // A board that loaded but threw while drawing shows the landing in its place with the error; the link stays online, and
    // the next board that draws clean clears it (land).
    function drawFailed(err) {
      console.error(err);
      state.down = { state: 'draw', error: err };
      $('#downLanding').innerHTML = BoardUI.drawLanding(err);
      $('#downLanding').hidden = false;
      B.root.classList.add('down');
    }
    B.on(B.root, 'click', (ev) => {
      const what = state.down?.error && ev.target.closest?.('button[data-draw]')?.dataset.draw;
      if (what === 'reload') location.reload();
      else if (what === 'copy') {
        navigator.clipboard?.writeText(state.down.error.stack || String(state.down.error)).then(() => B.toast('Copied'), () => B.toast('Couldn’t copy'));
      } else if (what === 'more') {
        const pre = $('#downLanding .down-landing-stack');
        pre.hidden = !pre.hidden;
        ev.target.textContent = pre.hidden ? 'Show details' : 'Hide details';
      }
    });
    B.every(5000, () => { if (state.down?.retries && !document.hidden) loadBoard(); });

    // A board from the server, a load's or an events POST's, or a patch from the board on screen (ui-patch.js). One built
    // before the board on screen leaves it as it is, so a slow load can't undo a newer one; a newer patch from a board
    // no longer on screen, which another answer replaced meanwhile, reloads instead. A patch's threads and notes go into
    // their caches before the board draws; then the threads the cache lacks load, or after a whole board every card's
    // thread and notes (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md,
    // docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md). → whether it landed
    function land(answer, load) {
      if (state.view === 'fresh' && state.board && answer.generatedAt < state.board.generatedAt) return false;
      const board = answer.since === undefined ? answer : BoardUI.applyPatch(state.view === 'fresh' ? state.board : null, answer);
      if (!board) { signalled(); return false; }
      const first = state.view !== 'fresh';
      state.board = board;
      state.oldCopy = false;
      if (answer.since !== undefined) {
        B.takeThreads(answer.threads || {});
        B.takeNotes(answer.notes || {});
      }
      if (state.down) {
        state.down = null;
        $('#downLanding').hidden = true;
        B.root.classList.remove('down');
      }
      B.setView('fresh');
      if (!hashRead || (first && focusKey)) { readHash(); hashRead = true; }
      B.linkUp();
      try { render(load); } catch (e) { drawFailed(e); return true; }
      if (first) { B.resendOutbox(); B.resendAnswers(); }
      filling = B.fillThreads({ whole: answer.since === undefined });
      if (answer.since === undefined) B.fillNotes();
      scrollToFocus();
      returnToPlace();
      B.site.syncBadge();
      B.saveCopySoon();
      return true;
    }

    // An owner tap that saves something (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md): the events POST
    // answers once the server has recorded the tap, with the board as the tap left it, which lands as a load of its own,
    // so the tap needs no reload (docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md); it names
    // the version on screen, so the answer is a patch from it. Nothing draws
    // before that answer. answered() runs once it comes, before its board lands. A refusal throws, carrying the
    // server's reason for failed.
    async function send(kind, data, answered = null) {
      const out = await B.site.send(kind, { ...data, ...(state.view === 'fresh' ? { since: state.board.version } : {}) });
      if (!B.alive()) return out;
      answered?.();
      if (!land(out.board, B.boardLoad = (B.boardLoad || 0) + 1)) await boardAfter(out.board.generatedAt);
      return out;
    }

    // A board that reload raced the POST left the tap's own board unlanded (land): the tap is not drawn until a board
    // made after it is, so send waits for one, and a tap's spinner with it (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
    async function boardAfter(generatedAt) {
      for (let tries = 0; tries < 3 && B.alive() && !(state.view === 'fresh' && state.board.generatedAt >= generatedAt); tries++) await (reloading || loadBoard({ via: 'signal' }));
    }

    // The server signals each change to what the board reads, through the shell, and the board reloads at once; the
    // 30 s poll stays as the fallback and the offline check (docs/adr/2026-10-29-1639-the-board-reloads-on-a-change-signal.md).
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

    // The toast for a tap the server refused, with its reason, or that never reached it.
    const failed = (e) => B.toast(e?.reason || 'That didn’t go through. Is the host awake?');
    // A tap's change no board has shown in BoardUI's PENDING_LATE_MS (ui.js pending): the board reloads once and the button rests.
    function stillWaiting() {
      if (!B.alive()) return;
      B.toast('Still waiting on the board');
      signalled();
      render();
    }
    // A tap that moves a card or asks for an agent (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md):
    // spinUntil(button, {send, shows}) runs send() and spins button (BoardUI.waitOn) until shows()
    // holds or send() fails, whichever comes first. shows() is asked after every board render and thread load, and once
    // send() resolves; it compares with what the tap saw, so a board from before the tap never ends the spinner. Sixty
    // seconds without either runs stillWaiting. → send()'s promise, so the caller still hears its answer or refusal.
    function spinUntil(button, { send, shows }) {
      let rest;
      const shown = new Promise((resolve) => { rest = resolve; });
      const check = () => { if (shows()) rest(); };
      showing.add(check);
      const sent = send();
      sent.then(check, rest);
      BoardUI.waitOn(button, BoardUI.pending.within(shown, stillWaiting).finally(() => showing.delete(check)));
      return sent;
    }
    function checkShown() { for (const check of [...showing]) check(); }
    Object.assign(B, { render, focusOnBoard, loadBoard, send, failed, stillWaiting, spinUntil, checkShown, reload: signalled });
    B.headerWired();
    B.on(document, 'visibilitychange', () => {
      if (document.hidden) return;
      if (signalMissed) { signalMissed = false; signalled(); } else loadBoard();
    });
    B.readCopy().then(paintCopy).catch((e) => console.error(e)).then(() => { if (B.alive()) loadBoard(); });
    B.signal?.(signalled);
    B.every(30000, () => { if (!document.hidden) { loadBoard(); } });
  }

  // shared: {by, full} for someone the board is shared with, whose board opens with a strip saying what they can do there
  // (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md). → the strip's inside
  function sharedStrip({ by, full }) {
    const from = `Shared with you${by ? ` by ${BoardUI.esc(by)}` : ''}.`;
    return full ? `<b>Full.</b> ${from} You can answer and act. Merge and Board settings are ${by ? `${BoardUI.esc(by)}’s` : 'the owner’s'}.`
      : `<b>View only.</b> ${from} You can look and open Visit links.`;
  }
  function markup({ title = '', shared = null } = {}) {
    const strip = shared ? `<p class="view-only-strip">${sharedStrip(shared)}</p>\n` : '';
    return `${BoardUI.header({ lead: 'logo', title, logoSrc: '/_hub/kickflip.png', pages: 'questions', moon: true, navStart: '<span id="waitsChip"></span>' })}
<div class="split">
<main>
${strip}  <section id="setup" class="setup" aria-live="polite" hidden></section>
  <section id="pauseBanner" class="hub-view" hidden></section>
  <section id="answers" class="answer-banner" hidden></section>
  <div id="tryMain"></div>
  <section id="newStrip" class="new-strip" aria-label="New" hidden></section>
  <div id="lanes"></div>
  <div id="downLanding" hidden></div>
  ${BoardUI.boardFoot()}
</main>
<div class="col-handle" data-col="pane" role="separator" aria-orientation="vertical" aria-label="Resize the Waiting on you pane" tabindex="0"></div>
<aside id="boardPane" class="board-pane" aria-label="Waiting on you"></aside>
</div>
${BoardNewTask.markup()}
<dialog id="mainLogSheet" class="sheet" aria-labelledby="mainLogTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h2 id="mainLogTitle"></h2><button type="button" class="ghost" id="mainLogClose" aria-label="Close">✕</button></div>
    <p id="mainLogSource" class="main-log-source muted small"></p>
    <pre id="mainLogLines" class="main-log-lines" tabindex="0" aria-label="Main’s build log"></pre>
    <p id="mainLogReason" class="small" role="status" hidden></p>
    <div class="main-log-actions"><button type="button" class="primary" id="mainLogRetry">Retry</button></div>
  </div>
</dialog>
<dialog id="holdSheet" class="sheet hold-sheet" aria-labelledby="holdTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h2 id="holdTitle" tabindex="-1"></h2><button type="button" class="ghost" id="holdClose" aria-label="Close">✕</button></div>
    <p id="holdLede" class="hold-lede muted"></p>
    <div id="holdPicker"></div>
  </div>
</dialog>
<dialog id="waitsSheet" class="sheet waits-sheet" aria-labelledby="waitsTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h2 id="waitsTitle"></h2><button type="button" class="ghost" id="waitsClose" aria-label="Close sheet">✕</button></div>
    <div id="waitsBody"></div>
  </div>
</dialog>
<dialog id="archSheet" class="sheet arch-sheet" aria-labelledby="archTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h2 id="archTitle">Architecture review</h2><button type="button" class="ghost" id="archClose" aria-label="Close sheet">✕</button></div>
    <div id="archBody" class="arch-body"></div>
  </div>
</dialog>
<dialog id="readerSheet" class="sheet reader-sheet" aria-labelledby="readerTitle">
  <div class="reader-head"><h2 id="readerTitle"></h2><span class="reader-ref"></span><span class="reader-tools"></span><button type="button" class="ghost" data-reader="close" aria-label="Close">✕</button></div>
  <div class="reader-body" tabindex="0"></div>
  <button type="button" class="reader-new" data-reader="end" hidden></button>
</dialog>
<dialog id="questionsSheet" class="sheet reader-sheet" aria-labelledby="questionsTitle">
  <div class="reader-head"><h2 id="questionsTitle">questions</h2><span class="reader-ref"></span><button type="button" class="ghost" data-qs="close" aria-label="Close">✕</button></div>
  <div class="reader-body" tabindex="0"></div>
</dialog>
<dialog id="lightbox" class="lightbox" aria-labelledby="lightboxName">
  <div class="lightbox-head"><b id="lightboxName" class="lightbox-name"></b><button type="button" class="ghost" data-lightbox="close" aria-label="Close">✕</button></div>
  <img alt="">
  <div class="lightbox-nav"><button type="button" class="ghost" data-lightbox="prev" aria-label="Previous image">‹</button><span class="lightbox-at"></span><button type="button" class="ghost" data-lightbox="next" aria-label="Next image">›</button></div>
</dialog>
<dialog id="linksSheet" class="sheet" aria-labelledby="linksTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h2 id="linksTitle">Hub links</h2><button type="button" class="ghost" id="linksClose" aria-label="Close">✕</button></div>
    <div id="linksList"></div>
  </div>
</dialog>`;
  }

  return { part, create, page, markup, sharedStrip };
})();
