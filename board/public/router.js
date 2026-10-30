// The app shell's router (docs/adr/0055-one-app-for-the-whole-hub.md): every URL on the hub names a view, and a view
// names its URL, so a push link, a reload and a shared link all land on the same view. viewOf and urlOf are pure;
// ui.test.mjs runs them in node:vm. listen() catches clicks on links to a view the shell mounts, and back and forward.
// A view is {kind, …}:
//   start                       `/`, which the shell turns into the last board
//   board {route, hash}         /<route>/, hash such as #item=<key>&reply
//   settings {route}            /<route>/settings.html
//   questions {route, id}       /<route>/questions.html#<id>
//   notes {route, item}         /<route>/notes.html?item=<key>, and plan.html, which the board redirects there
//   hub, hub-settings {hash}, polling {w}
//                               /_hub/, /_hub/settings, /_hub/settings/polling?w=<HH:MM>
//   frame {route, url}          any other page under a route, a folder or an .html file: other sites, prototypes and
//                               every other board page, shown in a frame
// Any other URL, such as an image or another origin, is no view (null) and loads as itself.
// A push's from=push mark (entryOf) is no part of the view, so a push link reads as the view its page shows.
globalThis.AppRouter = (function () {
  // The kinds the shell mounts in place; a link to any other kind loads its page.
  const MOUNTED = new Set(['board', 'settings', 'questions', 'notes', 'frame']);
  // A page's path under its route. hub/shell.mjs pageOf takes the same rule, so the hub answers a page load of every view
  // this mounts with the shell; hub/shell.test.mjs checks the two agree.
  const isPagePath = (rest) => rest === '' || rest.endsWith('/') || /\.html?$/.test(rest);

  // href against base; boards, the set of board routes. null for another origin.
  function viewOf(href, { boards = new Set(), base = globalThis.location?.href } = {}) {
    let u;
    try { u = new URL(href, base); } catch { return null; }
    if (base && u.origin !== new URL(base).origin) return null;
    const p = u.pathname;
    if (p === '/') return { kind: 'start' };
    if (p === '/_hub/') return { kind: 'hub' };
    if (p === '/_hub/settings') return { kind: 'hub-settings', hash: u.hash };
    if (p === '/_hub/settings/polling') return { kind: 'polling', w: u.searchParams.get('w') };
    const m = /^\/([^/]+)\/(.*)$/.exec(p);
    let route = null;
    try { route = m && decodeURIComponent(m[1]); } catch { return null; }
    if (!route || route === '_hub' || !isPagePath(m[2])) return null;
    const frame = { kind: 'frame', route, url: p + u.search + u.hash };
    if (!boards.has(route)) return frame;
    const page = m[2];
    if (page === '') return { kind: 'board', route, hash: u.hash };
    if (page === 'settings.html') return { kind: 'settings', route };
    if (page === 'questions.html') {
      let id = null;
      try { id = u.hash.length > 1 ? decodeURIComponent(u.hash.slice(1)) : null; } catch { id = u.hash.slice(1); }
      return { kind: 'questions', route, id };
    }
    if (page === 'notes.html' || page === 'plan.html') return { kind: 'notes', route, item: u.searchParams.get('item') };
    return frame;
  }

  function urlOf(view) {
    const r = view.route !== undefined ? `/${encodeURIComponent(view.route)}/` : '';
    switch (view.kind) {
      case 'start': return '/';
      case 'board': return r + (view.hash || '');
      case 'settings': return `${r}settings.html`;
      case 'questions': return `${r}questions.html${view.id ? `#${encodeURIComponent(view.id)}` : ''}`;
      case 'notes': return `${r}notes.html${view.item ? `?item=${encodeURIComponent(view.item)}` : ''}`;
      case 'hub': return '/_hub/';
      case 'hub-settings': return `/_hub/settings${view.hash || ''}`;
      case 'polling': return `/_hub/settings/polling${view.w ? `?w=${encodeURIComponent(view.w)}` : ''}`;
      default: return view.url;
    }
  }

  const mounted = (view) => Boolean(view && MOUNTED.has(view.kind));

  // A push to a page other than the board carries from=push (board/store.mjs pushUrl). The router keeps that mark in
  // the entry's history.state as pushed, which a reload keeps too, and drops it from the URL.
  // → {href without from=push, pushed}
  function entryOf(href) {
    const u = new URL(href, globalThis.location?.href);
    const pushed = u.searchParams.get('from') === 'push';
    if (pushed) u.searchParams.delete('from');
    return { href: u.href, pushed };
  }

  // Each history entry carries {idx}, its distance from the shell's first entry, and pushed when a push opened it.
  // A back arrow (a.back) goes one step back by them (ui-page-header.js backStep), else follows its href.
  // go(view, href, how) shows a view: how is 'push' for a link, a push tap or the start, 'pop' for back and forward;
  // it answers false, or a promise of false, when the view stays, such as when the owner keeps an unsaved edit, and a
  // refused pop then returns to the entry it left. boards() → the board routes now.
  // → {push(href), replace(href)}, which write an entry for a view go is showing.
  function listen({ boards, go }) {
    let idx = Number.isInteger(history.state?.idx) ? history.state.idx : 0;
    const first = entryOf(location.href);
    history.replaceState({ ...(history.state || {}), idx, ...(first.pushed ? { pushed: true } : {}) }, '', first.href);
    const write = (how, href) => {
      const { href: url, pushed } = entryOf(href);
      if (how === 'push' && url === location.href) return;
      if (how === 'push') idx++;
      history[how === 'push' ? 'pushState' : 'replaceState']({ idx, ...(pushed ? { pushed: true } : {}) }, '', url);
    };

    // Listens after sidebar.js, so a tap the drawer took (its logo, ✕) is already defaultPrevented.
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      if (a.classList.contains('back') && BoardUI.backStep({ pushed: history.state?.pushed === true, href: location.href, idx: history.state?.idx }) === 'back') {
        e.preventDefault();
        history.back();
        return;
      }
      const url = new URL(a.href, location.href);
      const view = viewOf(url.href, { boards: boards() });
      if (!mounted(view)) return;
      // A link to another card on this board, or another question on Waiting on you, only moves the hash, which the
      // view follows itself.
      if (url.pathname === location.pathname && url.search === location.search && url.hash && url.hash !== location.hash) return;
      e.preventDefault();
      go(view, url.href, 'push');
    });
    let restoring = false;
    addEventListener('popstate', (e) => {
      const was = idx;
      if (Number.isInteger(e.state?.idx)) idx = e.state.idx;
      if (restoring) { restoring = false; return; }
      const view = viewOf(location.href, { boards: boards() });
      if (!mounted(view)) { location.reload(); return; }
      Promise.resolve(go(view, location.href, 'pop')).then((shown) => {
        if (shown !== false || was === idx) return;
        restoring = true;
        history.go(was - idx);
      });
    });
    // A hash link adds an entry with no state of its own.
    addEventListener('hashchange', () => { if (!Number.isInteger(history.state?.idx)) history.replaceState({ idx: ++idx }, ''); });
    return { push: (href) => write('push', href), replace: (href) => write('replace', href) };
  }

  return { viewOf, urlOf, mounted, entryOf, listen };
})();
