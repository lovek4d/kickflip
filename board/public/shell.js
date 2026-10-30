// The app shell (app.html; docs/adr/0055-one-app-for-the-whole-hub.md): the sidebar, mounted once, beside one view at a
// time. A board's view is BoardView (app.js); its Settings, Waiting on you and Notes are AppViews.settings, .questions
// and .notes (view-*.js), each {className, title(view), markup(view), create(root, siteRoot, {view, reload})}.
// Following a link to any of them, the sidebar's included, swaps the view in place through router.js; any other link
// loads its page. Leaving a view whose root holds [data-dirty], an unsaved edit, asks first. The shell holds the hub's
// one stream, /_hub/stream (hub/stream.mjs): `change {route}` signals the open board, and `sidebar` repaints the
// sidebar. A board the shell leaves is unmounted; one left fresh whose stream sent no change since paints live when it
// comes back, and any other paints dimmed from its last visit (docs/adr/0028-the-board-opens-on-the-last-visit.md).
// A push tap reaches it from hub/sw.js as {open: url}, and a page framed inside it hands it a view's URL through
// AppShell.open(url, {replace}) → true when the shell shows it in place.
window.AppShell = (function () {
  const LAST_KEY = 'hub:lastBoard';
  const DATA_KEY = 'hub:sidebar';
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  let opener = null;
  const open = (url, opts) => Boolean(opener?.(url, opts));

  // The app shell around this page when it is framed in one.
  function outer() {
    try { return window.top !== window && typeof window.top.AppShell?.open === 'function' ? window.top.AppShell : null; } catch { return null; }
  }

  async function start() {
    // A frame that lands on a view's URL, such as a framed page's link back to its card, shows it in the shell around it.
    if (outer()?.open(location.href)) return;
    let data = null;
    try { data = JSON.parse(document.getElementById('sidebarData')?.textContent || 'null'); } catch { data = null; }
    // The board server's copy of the shell, for a load the hub forwards, carries no sidebar data.
    if (!data) {
      try { const r = await fetch('/_hub/sidebar.json', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch { /* the cached copy */ }
    }
    data ||= read(DATA_KEY);
    const sidebar = Sidebar.mount({ data, poll: false });
    const boards = () => new Set((data?.sites || []).filter((s) => s.board).map((s) => s.route));
    const titleOf = (route) => data?.sites?.find((s) => s.route === route)?.title || route;

    // route → the views' change listeners; a view subscribes through BoardView.create's signal.
    const listeners = new Map();
    const signalFor = (route) => (fn) => {
      if (!listeners.has(route)) listeners.set(route, new Set());
      listeners.get(route).add(fn);
      return () => listeners.get(route)?.delete(fn);
    };
    // route → {fresh, generatedAt} for each board left fresh with no change since. Trusted only while the stream is up:
    // a dropped stream may have missed a change, so its return forgets them all.
    const left = new Map();
    let streamUp = false;
    let current = null;
    function changed(route) {
      left.delete(route);
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
        streamUp = true;
        if (opened) { left.clear(); if (current) changed(current.route); }
        opened = true;
      });
      cur.addEventListener('change', (e) => {
        let d = null;
        try { d = JSON.parse(e.data); } catch { return; }
        if (typeof d?.route === 'string') changed(d.route);
      });
      cur.addEventListener('sidebar', (e) => {
        try { data = JSON.parse(e.data); } catch { return; }
        sidebar.setData(data);
      });
      cur.addEventListener('error', () => {
        streamUp = false;
        if (cur.readyState !== EventSource.CLOSED || es !== cur) return;
        retry = setTimeout(openStream, Math.min(30000, 1000 * 2 ** tries++));
      });
    }

    const scrim = document.getElementById('sidebarScrim');
    // current: {view, route, root, v}, the router's view shown, its root element and its mounted {B, mount, unmount}.
    function show(view) {
      const { route } = view;
      const board = view.kind === 'board';
      if (current) {
        const st = current.v.B.state;
        const keep = streamUp && st?.view === 'fresh' && st.board ? { fresh: st.fresh, generatedAt: st.board.generatedAt } : null;
        current.v.unmount();
        if (keep) left.set(current.route, keep);
      }
      const page = board ? null : AppViews[view.kind];
      const root = document.createElement('div');
      root.className = board ? 'view-board' : page.className;
      root.innerHTML = board ? BoardView.markup({ title: titleOf(route) }) : page.markup(view);
      if (current) current.root.replaceWith(root); else scrim.after(root);
      const siteRoot = '/' + encodeURIComponent(route);
      let v;
      if (board) {
        const live = streamUp ? left.get(route) || null : null;
        left.delete(route);
        v = BoardView.create(root, siteRoot, { signal: signalFor(route), live });
      } else v = page.create(root, siteRoot, { view, reload: () => go(current.view, location.href, 'reload') });
      current = { view, route, root, v };
      document.title = board ? titleOf(route) : page.title(view);
      try { localStorage.setItem(LAST_KEY, route); } catch { /* no storage: `/` opens the start board */ }
      sidebar.setHere(route);
      scrollTo(0, 0);
      v.mount();
    }

    // The board and Waiting on you follow their own hash, so a link that only moves it keeps the view.
    const sameView = (a, b) => a.kind === b.kind && a.route === b.route && (a.kind !== 'notes' || a.item === b.item);
    const dirty = () => Boolean(current?.root.querySelector('[data-dirty]'));
    addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

    // go(view, href, how): router.js's, with how 'replace' for a framed page's hand-off and 'reload' for a view's own
    // refresh. → true, or a promise of whether the view switched once the owner answers about an unsaved edit.
    let router = null;
    function go(view, href, how) {
      if (!AppRouter.mounted(view)) return false;
      const stays = how !== 'reload' && current && sameView(current.view, view);
      const finish = () => {
        if (how === 'push') router.push(href);
        else if (how === 'replace') router.replace(href);
        if (!stays) show(view);
        else {
          current.view = view;
          if (how !== 'pop') dispatchEvent(new HashChangeEvent('hashchange'));
        }
        sidebar.close();
        return true;
      };
      if (stays || !dirty()) return finish();
      return BoardDialogs.confirm('Leave without saving? Your unsaved edits here will be lost.').then((leave) => (leave ? finish() : false));
    }

    // `/` opens this device's last board, else the board the hub picks (sidebar data's start), else the hub's page
    // (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md).
    let first = AppRouter.viewOf(location.href, { boards: boards() });
    if (first?.kind === 'start') {
      let last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch {}
      const pick = boards().has(last) ? last : data?.start || null;
      if (!pick) { location.replace('/_hub/'); return; }
      if (!boards().has(pick)) { location.replace(`/${encodeURIComponent(pick)}/`); return; }
      history.replaceState(history.state, '', `/${encodeURIComponent(pick)}/`);
      first = AppRouter.viewOf(location.href, { boards: boards() });
    }
    if (!AppRouter.mounted(first)) { location.replace('/_hub/'); return; }

    router = AppRouter.listen({ boards, go });
    opener = (url, { replace = false } = {}) => {
      const view = AppRouter.viewOf(url, { boards: boards() });
      if (!AppRouter.mounted(view)) return false;
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
    openStream();
    addEventListener('visibilitychange', () => { if (!document.hidden) openStream(); });
    addEventListener('pageshow', openStream);
    // A page kept in the back-forward cache keeps its stream's connection, and a few such pages take every connection
    // the browser allows the hub, so the next page's requests wait.
    addEventListener('pagehide', (e) => {
      if (!e.persisted || !es) return;
      clearTimeout(retry);
      streamUp = false;
      es.close();
    });
  }

  return { start, open };
})();
