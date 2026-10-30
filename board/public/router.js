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
//   frame {url}                 anything else on the hub: other sites, prototypes and every other board page
globalThis.AppRouter = (function () {
  // The kinds the shell mounts in place; a link to any other kind loads its page.
  const MOUNTED = new Set(['board']);

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
    const frame = { kind: 'frame', url: p + u.search + u.hash };
    const m = /^\/([^/]+)\/([^/]*)$/.exec(p);
    let route = null;
    try { route = m && decodeURIComponent(m[1]); } catch { return frame; }
    if (!route || !boards.has(route)) return frame;
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

  // Each history entry carries {idx}, its distance from the shell's first entry, which ui-page-header.js backStep reads.
  // go(view, href, how) shows a view: how is 'push' for a link, a push tap or the start, 'pop' for back and forward.
  // boards() → the board routes now.
  function listen({ boards, go }) {
    let idx = Number.isInteger(history.state?.idx) ? history.state.idx : 0;
    history.replaceState({ ...(history.state || {}), idx }, '');
    const push = (href) => { if (href !== location.href) history.pushState({ idx: ++idx }, '', href); };

    // Listens after sidebar.js, so a tap the drawer took (its logo, ✕) is already defaultPrevented.
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, location.href);
      const view = viewOf(url.href, { boards: boards() });
      if (!mounted(view)) return;
      // A link to another card on this board is a hash change, which the board view follows itself.
      if (url.pathname === location.pathname && url.search === location.search && url.hash && url.hash !== location.hash) return;
      e.preventDefault();
      go(view, url.href, 'push');
    });
    addEventListener('popstate', (e) => {
      if (Number.isInteger(e.state?.idx)) idx = e.state.idx;
      const view = viewOf(location.href, { boards: boards() });
      if (mounted(view)) go(view, location.href, 'pop'); else location.reload();
    });
    // A hash link adds an entry with no state of its own.
    addEventListener('hashchange', () => { if (!Number.isInteger(history.state?.idx)) history.replaceState({ idx: ++idx }, ''); });
    return { push };
  }

  return { viewOf, urlOf, mounted, listen };
})();
