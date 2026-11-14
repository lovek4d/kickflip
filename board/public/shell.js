// The app shell (app.html; docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md): the sidebar, mounted once, beside one view at a
// time. A board's view is BoardView (app.js); Waiting on you and Notes are AppViews.questions and .notes,
// the Hub page AppViews.hub with its settings modals, and every other page AppViews.frame. Board Settings mounts over the board
// as a modal. Each page is {className, title(view, {siteTitle}), markup(view, {siteTitle}), create(root,
// siteRoot, ctx)}; a hub page's siteRoot is /_hub. Following a link to any of them, the sidebar's included, swaps the
// view in place through router.js; a link to anything that isn't a page loads it. Leaving a view whose root holds
// [data-dirty], an unsaved edit, asks first. The shell holds the hub's one stream, /_hub/stream
// (hub/stream.mjs): `change {route}` signals the open board, and `sidebar` repaints the sidebar. A board the shell
// leaves is unmounted, and paints live from its saved copy when it comes back
// (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md).
// A push tap reaches it from hub/sw.js as {open: url}, and a page framed inside it hands it a view's URL through
// AppShell.open(url, {replace, frames}) → true when the shell shows it in place; frames false refuses a frame view.
// AppShell.reload() reloads the app past the shell the service worker keeps.
window.AppShell = (function () {
  const LAST_KEY = 'hub:lastBoard';
  const DATA_KEY = 'hub:sidebar';
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  let opener = null;
  const open = (url, opts) => Boolean(opener?.(url, opts));
  let bootCode = null;
  let updateReady = false;
  let sidebar = null;
  function codeSeen(hash) {
    if (!hash) return;
    if (!bootCode) { bootCode = hash; return; }
    if (hash !== bootCode && !updateReady) { updateReady = true; sidebar?.setUpdate('ready'); }
  }

  async function reload() {
    const controller = navigator.serviceWorker?.controller;
    if (controller) await new Promise((resolve) => {
      const channel = new MessageChannel();
      const done = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(); };
      const timer = setTimeout(done, 1000);
      channel.port1.onmessage = done;
      try { controller.postMessage({ forget: 'shell' }, [channel.port2]); } catch { done(); }
    });
    // Only this reload starts at the top: iOS put the old offset back once the page had grown and left that area unpainted until a scroll
    // (docs/adr/2026-11-06-1100-the-shell-turns-off-scroll-restoration.md). pagehide gives ordinary reloads their restore back.
    history.scrollRestoration = 'manual';
    addEventListener('pagehide', () => { history.scrollRestoration = 'auto'; }, { once: true });
    setTimeout(() => location.reload(), 0);
  }

  // The app shell around this page when it is framed in one.
  function outer() {
    try { return window.top !== window && typeof window.top.AppShell?.open === 'function' ? window.top.AppShell : null; } catch { return null; }
  }

  async function start() {
    // A frame that lands on a view's URL, such as a framed page's link back to its card, shows it in the shell around it.
    if (outer()?.open(location.href, { frames: false })) return;
    // The same URL and scope as hub-kit.js's push registration, so the one registration and its push subscription stay.
    navigator.serviceWorker?.register('/sw.js', { scope: '/' }).catch(() => {});
    let data = null;
    try { data = JSON.parse(document.getElementById('sidebarData')?.textContent || 'null'); } catch { data = null; }
    // The board server's copy of the shell, for a load the hub forwards, carries no sidebar data.
    if (!data) {
      try { const r = await fetch('/_hub/sidebar.json', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch { /* the cached copy */ }
    }
    // A stored sidebar's code says nothing about the shell that booted, so it adopts the next live hash.
    bootCode = data?.code || null;
    data ||= read(DATA_KEY);
    // A board shared with someone else (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md):
    // the hub sends them data.shared, and style.css hides what writes under .shared-view. On a board they have Full on
    // (data.shared.full; docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md) the page is .shared-full too,
    // which shows the composers and card buttons again; levelHere follows the route shown and each sidebar event.
    const shared = data?.shared || null;
    document.documentElement.classList.toggle('shared-view', Boolean(shared));
    const sharedHere = (route) => ({ by: data?.shared?.by ?? null, full: Boolean(data?.shared?.full?.includes(route)) });
    function levelHere() {
      if (!shared || !current) return;
      const here = sharedHere(current.route);
      document.documentElement.classList.toggle('shared-full', here.full);
      const strip = current.root.querySelector('.view-only-strip');
      if (strip) strip.innerHTML = BoardView.sharedStrip(here);
    }
    sidebar = Sidebar.mount({ data, poll: false, reload, open: (href) => { if (!open(href)) location.assign(href); } });
    const boards = () => new Set((data?.sites || []).filter((s) => s.board).map((s) => s.route));
    const titleOf = (route) => data?.sites?.find((s) => s.route === route)?.title || route;

    // route → the views' change listeners; a view subscribes through BoardView.create's signal.
    const listeners = new Map();
    const signalFor = (route) => (fn) => {
      if (!listeners.has(route)) listeners.set(route, new Set());
      listeners.get(route).add(fn);
      return () => listeners.get(route)?.delete(fn);
    };
    let current = null;
    function changed(route) {
      for (const fn of listeners.get(route) || []) fn();
    }

    let es = null;
    let opened = false;
    let tries = 0;
    let retry = null;
    // An EventSource retries a dropped stream by itself, but gives up on an answer that isn't a stream, such as while
    // the hub restarts, so a closed one reopens here with a growing backoff.
    function openStream() {
      if (!('EventSource' in window) || (es && es.readyState !== EventSource.CLOSED)) return;
      clearTimeout(retry);
      const cur = es = new EventSource('/_hub/stream');
      cur.addEventListener('open', () => {
        tries = 0;
        if (opened && current) changed(current.route);
        opened = true;
      });
      cur.addEventListener('change', (e) => {
        let d = null;
        try { d = JSON.parse(e.data); } catch { return; }
        if (typeof d?.route === 'string') changed(d.route);
      });
      cur.addEventListener('sidebar', (e) => {
        try { data = JSON.parse(e.data); } catch { return; }
        codeSeen(data.code);
        sidebar.setData(data);
        levelHere();
        current?.v?.B?.renderStatus?.();
      });
      cur.addEventListener('error', () => {
        if (cur.readyState !== EventSource.CLOSED || es !== cur) return;
        retry = setTimeout(openStream, Math.min(30000, 1000 * 2 ** tries++));
      });
    }

    // A tap, key or scroll on any page tells the hub the owner is here (hub/presence.mjs ownerTracker), at most once a
    // minute while present. While away the first one goes at once and the moon goes from this page at the same moment
    // (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md).
    let beatAt = 0;
    // A shared person's taps are never the owner's.
    const beat = () => {
      if (shared) return;
      const away = Boolean(data?.away);
      if (!away && Date.now() - beatAt < 60_000) return;
      beatAt = Date.now();
      if (away) { data = { ...data, away: false }; current?.v?.B?.renderStatus?.(); }
      fetch('/_hub/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => { beatAt = 0; });
    };
    for (const type of ['pointerdown', 'keydown', 'scroll']) addEventListener(type, beat, { capture: true, passive: true });

    // docs/adr/2026-11-05-1834-while-typing-the-header-is-a-strip-and-the-send-bar-sits-on-the-keyboard.md
    // While a text field has focus :root.typing is set and style.css disables the floating + (New task); nothing else
    // on the page moves.
    document.addEventListener('focusin', (ev) => {
      document.documentElement.classList.toggle('typing', ev.target.matches?.('textarea, input[type="text"], input:not([type])') ?? false);
    });
    document.addEventListener('focusout', () => document.documentElement.classList.remove('typing'));

    // A view that changed what the sidebar's foot rows say, such as notifications, asks for a fresh copy
    // rather than waiting for the stream's next one.
    async function refreshSidebar() {
      sidebar.checkDevice();
      try {
        const r = await fetch('/_hub/sidebar.json', { cache: 'no-store' });
        if (r.ok) { data = await r.json(); codeSeen(data.code); sidebar.setData(data); current?.v?.B?.renderStatus?.(); }
      } catch { /* the stream brings the next copy */ }
    }

    const scrim = document.getElementById('sidebarScrim');
    let settings = null;
    function removeSettings() {
      if (!settings) return;
      settings.v.unmount();
      settings.root.remove();
      settings = null;
    }
    function dismissSettings() {
      const closing = settings;
      const finish = () => {
        if (settings !== closing) return;
        removeSettings();
        router.replace(AppRouter.urlOf(current.view));
      };
      if (!settings?.root.querySelector('[data-dirty]')) { finish(); return; }
      BoardDialogs.confirm('Leave without saving? Your unsaved edits here will be lost.').then((leave) => { if (leave) finish(); });
    }
    function showSettings() {
      if (settings) return;
      const root = document.createElement('div');
      root.className = 'view-settings';
      root.innerHTML = AppViews.settings.markup({}, { siteTitle: titleOf(current.route) });
      current.root.appendChild(root);
      const v = AppViews.settings.create(root, '/' + encodeURIComponent(current.route), { dismiss: dismissSettings, open: openHere, sidebarChanged: refreshSidebar, siteTitle: titleOf(current.route) });
      settings = { root, v };
      v.mount();
    }

    // current: {view, route, root, v}, the router's view shown, its root element and its mounted {B, mount, unmount}.
    function show(view) {
      const modal = view.kind === 'settings';
      if (modal) view = { kind: 'board', route: view.route, hash: '' };
      removeSettings();
      const { route } = view;
      const board = view.kind === 'board';
      const hub = route === undefined;
      const siteTitle = hub ? 'Hub' : titleOf(route);
      if (current) current.v.unmount();
      const page = board ? null : AppViews[view.kind];
      const root = document.createElement('div');
      root.className = board ? 'view-board' : page.className;
      root.innerHTML = board ? BoardView.markup({ title: siteTitle, shared: shared && sharedHere(route) }) : page.markup(view, { siteTitle });
      if (current) current.root.replaceWith(root); else scrim.after(root);
      const siteRoot = hub ? '/_hub' : '/' + encodeURIComponent(route);
      let v;
      if (board) {
        v = BoardView.create(root, siteRoot, { signal: signalFor(route), pause: () => data?.sites?.find((s) => s.route === route)?.pause || data?.pause, away: () => data?.away });
      } else {
        v = page.create(root, siteRoot, { view, siteTitle, boards, open: openHere, toggleSidebar: sidebar.toggle, keydown: sidebar.keydown, pointerdown: sidebar.pointerdown,
          reload: () => go(AppRouter.viewOf(location.href, { boards: boards() }), location.href, 'reload'), closeSidebar: sidebar.close, up: () => router.up(),
          loaded: (url, title) => { if (current?.v === v) framed(url, title); }, sidebarChanged: refreshSidebar });
      }
      current = { view, route, root, v };
      levelHere();
      document.title = board ? siteTitle : page.title(view, { siteTitle });
      if (boards().has(route)) { try { localStorage.setItem(LAST_KEY, route); } catch { /* no storage: `/` opens the start board */ } }
      sidebar.setHere(hub ? new URL(AppRouter.urlOf(view), location.href).pathname.slice(1) : route);
      scrollTo(0, 0);
      v.mount();
      if (modal) showSettings();
    }

    // A framed page loaded url in the frame: the top's URL and title follow it, without a history entry of their own,
    // since the frame's navigation made one. Any other view shows in the top instead.
    function framed(url, title) {
      const { href } = AppRouter.entryOf(url);
      const view = AppRouter.viewOf(href, { boards: boards() });
      if (view && view.kind !== 'frame') { if (!opener(href, { replace: true })) location.replace(href); return; }
      document.title = title;
      if (!view) return;
      history.replaceState(history.state, '', href);
      current.view = view;
      if (view.route !== current.route) { current.route = view.route; sidebar.setHere(view.route); }
    }
    const openHere = (href) => { if (!opener(href)) location.assign(href); };

    // The board and Waiting on you follow their own hash, so a link that only moves it keeps the view.
    const sameView = (a, b) => a.kind === b.kind && a.route === b.route && (a.kind !== 'notes' || a.item === b.item) && (a.kind !== 'frame' || a.url === b.url);
    const dirty = () => Boolean(current?.root.querySelector('[data-dirty]'));
    addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

    // go(view, href, how, from): router.js's, with how 'replace' for a framed page's hand-off and 'reload' for a view's
    // own refresh. → true, or a promise of whether the view switched once the owner answers about an unsaved edit.
    let router = null;
    const wide = matchMedia('(min-width: 900px)');
    // Board and Waiting on you are a board's two pages (docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md):
    // from 900px the board shows Waiting on you in its pane, so every view of the questions page, a link, a push, a
    // hand-off, a history entry or a cold load, shows the board at its own URL and opens the question's topic there (id,
    // or null for none). A board's prototype page does the same and opens in the pane
    // (docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md).
    const inPane = (view) => wide.matches && (view?.kind === 'questions' || AppRouter.isPrototype(view, boards()));
    // ask(B) → true once the board's pane did what the view asks. A board just shown takes a moment to fill its pane, so
    // the pane is asked again until it has.
    // A push tap (from=push) on a question of a card also opens its questions sheet (app-questions-sheet.js).
    const paneAsk = (view, href) => (view.kind === 'questions' ? (B) => B.focusQuestion?.(view.id, { sheet: AppRouter.entryOf(href).pushed }) : (B) => B.openViewer?.(href));
    // A newer ask drops the retries of an older one, so a late retry never sets an earlier pick over the later one.
    let asked = 0;
    function askPane(ask, tries = 50, mine = ++asked) {
      if (mine !== asked || current?.view.kind !== 'board' || ask(current.v.B) || tries <= 0) return;
      setTimeout(() => askPane(ask, tries - 1, mine), 100);
    }
    function go(view, href, how, from) {
      if (!AppRouter.mounted(view)) return false;
      if (inPane(view)) {
        const ask = paneAsk(view, href);
        const board = { kind: 'board', route: view.route, hash: '' };
        const boardHref = new URL(AppRouter.urlOf(board), location.href).href;
        if (how === 'pop') history.replaceState(history.state, '', boardHref);
        // On its own board it only asks the board, which sets the selection (app-selection.js), so the history stays as it is.
        else if (current?.view.kind === 'board' && current.route === view.route && !settings) {
          askPane(ask);
          sidebar.close();
          return true;
        }
        return Promise.resolve(go(board, boardHref, how, from)).then((shown) => { if (shown) askPane(ask); return shown; });
      }
      if (view.kind === 'settings') {
        if (current?.view.kind === 'board' && current.route === view.route) {
          const here = AppRouter.viewOf(location.href, { boards: boards() });
          if (here?.kind === 'board') current.view = here;
          router.replace(href);
          showSettings();
          sidebar.close();
          return true;
        }
        const board = { kind: 'board', route: view.route, hash: '' };
        return Promise.resolve(go(board, AppRouter.urlOf(board), how, from)).then((shown) => {
          if (!shown) return false;
          router.replace(href);
          showSettings();
          return true;
        });
      }
      if (view.kind === 'hub' && current?.view.kind === 'hub' && how !== 'reload') {
        return Promise.resolve(current.v.B.openSettings(view)).then((shown) => {
          if (shown) { current.view = view; sidebar.close(); }
          return shown;
        });
      }
      const stays = how !== 'reload' && current && sameView(current.view, view);
      const finish = () => {
        const moved = how === 'push' ? router.push(href, from) : how === 'replace' ? router.replace(href) : null;
        if (moved === 'up') { sidebar.close(); return true; }
        if (!stays) show(view);
        else {
          current.view = view;
          if (how !== 'pop') dispatchEvent(new HashChangeEvent('hashchange'));
        }
        sidebar.close();
        return true;
      };
      if ((stays && !settings) || !dirty()) { if (stays && settings) removeSettings(); return finish(); }
      return BoardDialogs.confirm('Leave without saving? Your unsaved edits here will be lost.').then((leave) => (leave ? (removeSettings(), finish()) : false));
    }

    // `/` opens this device's last board, else the board the hub picks (sidebar data's start), else the hub's page
    // (docs/adr/2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md).
    let first = AppRouter.viewOf(location.href, { boards: boards() });
    if (first?.kind === 'start') {
      let last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch {}
      const pick = boards().has(last) ? last : data?.start || null;
      history.replaceState(history.state, '', boards().has(pick) ? `/${encodeURIComponent(pick)}/` : '/_hub/');
      first = AppRouter.viewOf(location.href, { boards: boards() });
    }
    if (!AppRouter.mounted(first)) { location.replace('/_hub/'); return; }

    let pane = null;
    if (inPane(first)) {
      pane = paneAsk(first, location.href);
      first = { kind: 'board', route: first.route, hash: '' };
      history.replaceState(history.state, '', AppRouter.urlOf(first));
    }
    router = AppRouter.listen({ boards, go, wide: () => wide.matches });
    // Widening past 900px on Waiting on you or a prototype swaps to the board with it open in the pane.
    wide.addEventListener('change', () => {
      if (current && inPane(current.view)) go(AppRouter.viewOf(location.href, { boards: boards() }), location.href, 'replace');
    });
    opener = (url, { replace = false, frames = true } = {}) => {
      const view = AppRouter.viewOf(url, { boards: boards() });
      if (!AppRouter.mounted(view) || (!frames && view.kind === 'frame')) return false;
      go(view, new URL(url, location.href).href, replace ? 'replace' : 'push');
      return true;
    };
    // Answered at once, since the switch may wait on the owner's answer about an unsaved edit.
    navigator.serviceWorker?.addEventListener('message', (e) => {
      const url = e.data?.open;
      if (typeof url !== 'string') return;
      e.ports?.[0]?.postMessage({ routed: open(url) });
    });
    navigator.serviceWorker?.startMessages?.();

    show(first);
    if (pane) askPane(pane);
    openStream();
    addEventListener('visibilitychange', () => { if (!document.hidden) openStream(); });
    addEventListener('pageshow', openStream);
    // A page kept in the back-forward cache keeps its stream's connection, and a few such pages take every connection
    // the browser allows the hub, so the next page's requests wait.
    addEventListener('pagehide', (e) => {
      if (!e.persisted || !es) return;
      clearTimeout(retry);
      es.close();
    });
  }

  return { start, open, codeSeen, reload };
})();
