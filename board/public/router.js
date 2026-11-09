// The app shell's router (docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md): every URL on the hub names a view, and a view
// names its URL, so a push link, a reload and a shared link all land on the same view. viewOf and urlOf are pure;
// ui.test.mjs runs them in node:vm. listen() catches clicks on links to a view the shell mounts, and back and forward.
// A view is {kind, …}:
//   start                       `/`, which the shell turns into the last board
//   board {route, hash}         /<route>/, hash such as #selectedCard=<key>&openItemsCard=<topic id>, or the older #item=<key>&reply
//   settings {route}            /<route>/settings.html, a request to open the modal over that board
//   questions {route, id}       /<route>/questions.html#<id>
//   notes {route, item | wave}  /<route>/notes.html?item=<key> or ?wave=<wave slug>, and plan.html, which the board
//                               redirects there
//   hub {hash}                  /_hub/ with a settings modal named by hash; legacy /_hub/settings opens the same modals
//                               ([hub settings open as modals](docs/adr/2026-11-01-1221-hub-settings-open-as-modals.md)),
//                               and the old Polling page, /_hub/settings/polling, opens Quiet hours
//   frame {route, url}          any other page under a route, a folder or an .html file: other sites, prototypes and
//                               every other board page, shown in a frame
// Any other URL, such as an image or another origin, is no view (null) and loads as itself.
// A push's from=push mark (entryOf) is no part of the view, so a push link reads as the view its page shows.
globalThis.AppRouter = (function () {
  // The kinds the shell mounts in place; a link to any other kind loads its page.
  const MOUNTED = new Set(['board', 'settings', 'questions', 'notes', 'hub', 'frame']);
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
    if (['/_hub/', '/_hub/settings', '/_hub/settings/polling'].includes(p)) {
      const hash = p === '/_hub/settings/polling' ? '#quiet' : u.hash || (p === '/_hub/settings' ? '#notifications' : '');
      return { kind: 'hub', ...(hash ? { hash } : {}) };
    }
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
      if (id?.startsWith('openItemsCard=')) id = id.slice('openItemsCard='.length);
      return { kind: 'questions', route, id };
    }
    if (page === 'notes.html' || page === 'plan.html') {
      return u.searchParams.has('wave') ? { kind: 'notes', route, wave: u.searchParams.get('wave') } : { kind: 'notes', route, item: u.searchParams.get('item') };
    }
    return frame;
  }

  function urlOf(view) {
    const r = view.route !== undefined ? `/${encodeURIComponent(view.route)}/` : '';
    switch (view.kind) {
      case 'start': return '/';
      case 'board': return r + (view.hash || '');
      case 'settings': return `${r}settings.html`;
      case 'questions': return `${r}questions.html${view.id ? `#${encodeURIComponent(view.id)}` : ''}`;
      case 'notes': return `${r}notes.html${view.wave ? `?wave=${encodeURIComponent(view.wave)}` : view.item ? `?item=${encodeURIComponent(view.item)}` : ''}`;
      case 'hub': return `/_hub/${view.hash || ''}`;
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

  // The page tree (docs/adr/2026-10-30-1125-back-follows-the-page-tree.md): a board, its Waiting on you, and a prototype page tied
  // to one of its questions by ?q=, framed. levelOf → 0, 1 or 2 down the tree, or null for a view outside it.
  // A board's prototype page, which from 900px opens in the board's right pane (shell.js go).
  const isPrototype = (view, boards) => view?.kind === 'frame' && boards.has(view.route) && /^\/[^/]+\/prototype-[\w-]+\.html$/.test(new URL(view.url, 'http://hub').pathname);
  function questionOf(view, boards) {
    return isPrototype(view, boards) ? new URL(view.url, 'http://hub').searchParams.get('q') || null : null;
  }
  // wide: from 900px Waiting on you is the board's pane, so a prototype's parent is the board itself.
  function levelOf(view, { boards = new Set(), wide = false } = {}) {
    if (view?.kind === 'board') return 0;
    if (view?.kind === 'questions') return 1;
    return questionOf(view, boards) ? (wide ? 1 : 2) : null;
  }
  // → the views above view in the tree, its board first. card: the card whose thread the owner left the board from,
  // which the board keeps open.
  function parentsOf(view, { boards = new Set(), card = null, wide = false } = {}) {
    const q = questionOf(view, boards);
    if (!q && view?.kind !== 'questions') return [];
    const board = { kind: 'board', route: view.route, hash: card ? `#selectedCard=${encodeURIComponent(card)}` : '' };
    return q && !wide ? [board, { kind: 'questions', route: view.route, id: q }] : [board];
  }

  // Each history entry carries {idx}, its distance from the shell's first entry, pushed when a push opened it, and on a
  // view in the page tree up, how many of the entries under it are its parents. Every way into the tree writes the
  // parents it lacks under it, so a back arrow there (up), the browser's back and a swipe all go up one level. Any other
  // back arrow (a.back) goes one step back by idx and pushed (ui-page-header.js backStep), else follows its href.
  // go(view, href, how, from) shows a view: how is 'push' for a link, a push tap or the start, 'pop' for back and
  // forward; from.card is the open card a link was tapped in. It answers false, or a promise of false, when the view
  // stays, such as when the owner keeps an unsaved edit, and a refused pop then returns to the entry it left.
  // boards() → the board routes now.
  // → {push(href, from), replace(href), up()}: push and replace write an entry for a view go is showing; replace answers
  // 'up' when it went back to a parent instead, which then takes href, and go shows it on that pop.
  function listen({ boards, go, wide = () => false }) {
    const b = () => ({ boards: boards(), wide: wide() });
    const mark = (pushed) => (pushed ? { pushed: true } : {});
    let idx = Number.isInteger(history.state?.idx) ? history.state.idx : 0;
    let landing = null;
    const put = (how, href, state) => {
      if (how === 'push') idx++;
      history[how === 'push' ? 'pushState' : 'replaceState']({ idx, ...state }, '', href);
    };
    // Pushes parents, then href. up: the current entry's own up when the first parent sits on it, else -1, so a board
    // pushed first carries none.
    const climb = (parents, href, pushed, up) => {
      for (const p of parents) put('push', urlOf(p), up++ >= 0 ? { up } : {});
      put('push', href, { ...(up >= 0 ? { up: up + 1 } : {}), ...mark(pushed) });
    };

    const first = entryOf(location.href);
    const start = viewOf(first.href, b());
    const depth = levelOf(start, b());
    if (depth && !(history.state?.up >= depth)) {
      const parents = parentsOf(start, b());
      put('replace', urlOf(parents[0]), {});
      climb(parents.slice(1), first.href, first.pushed, 0);
    } else history.replaceState({ ...(history.state || {}), idx, ...mark(first.pushed) }, '', first.href);

    function write(how, href, { card = null } = {}) {
      const { href: url, pushed } = entryOf(href);
      if (how === 'push' && url === location.href) return;
      const view = viewOf(url, b());
      const here = viewOf(location.href, b());
      const level = levelOf(view, b());
      const at = here && view && here.route === view.route ? levelOf(here, b()) : null;
      const below = history.state?.up || 0;
      const keep = level !== null && level === at && below ? { up: below } : {};
      if (how === 'replace') {
        if (level !== null && at !== null && level < at && at - level <= below) {
          landing = href;
          history.go(level - at);
          return 'up';
        }
        put('replace', url, { ...keep, ...mark(pushed) });
        return;
      }
      // Another question on Waiting on you takes this one's place, so back still goes to the board.
      if (level === 1 && at === 1) { put('replace', url, { ...keep, ...mark(pushed) }); return; }
      const parents = parentsOf(view, { ...b(), card });
      if (level !== null && at !== null && at < level) {
        history.replaceState(history.state, '', urlOf(parents[at]));
        climb(parents.slice(at + 1), url, pushed, below);
      } else climb(parents, url, pushed, -1);
    }

    // A back arrow's tap on a view in the tree: back when its parent is the entry under it, else on to the parent.
    // → false for a view outside the tree.
    function up() {
      const parents = parentsOf(viewOf(location.href, b()), b());
      if (!parents.length) return false;
      if (history.state?.up > 0) history.back();
      else go(parents.at(-1), new URL(urlOf(parents.at(-1)), location.href).href, 'push');
      return true;
    }

    // Listens after sidebar.js, so a tap the drawer took (its logo, ✕) is already defaultPrevented.
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      if (a.classList.contains('back')) {
        if (up()) { e.preventDefault(); return; }
        if (BoardUI.backStep({ pushed: history.state?.pushed === true, href: location.href, idx: history.state?.idx }) === 'back') {
          e.preventDefault();
          history.back();
          return;
        }
      }
      const url = new URL(a.href, location.href);
      const view = viewOf(url.href, { boards: boards() });
      if (!mounted(view)) return;
      // A link to another card on this board, or another question on Waiting on you, only moves the hash, which the
      // view follows itself. On Waiting on you it takes this entry's place, so back still goes to the board.
      if (url.pathname === location.pathname && url.search === location.search && url.hash && url.hash !== location.hash) {
        if (view.kind === 'hub') { e.preventDefault(); go(view, url.href, 'push'); return; }
        if (view.kind !== 'questions') return;
        e.preventDefault();
        write('replace', url.href);
        dispatchEvent(new HashChangeEvent('hashchange'));
        return;
      }
      e.preventDefault();
      go(view, url.href, 'push', { card: a.closest?.('details.item[open][data-key]')?.dataset.key || null });
    });
    let restoring = false;
    addEventListener('popstate', (e) => {
      const was = idx;
      if (Number.isInteger(e.state?.idx)) idx = e.state.idx;
      if (landing) {
        const to = entryOf(landing);
        landing = null;
        history.replaceState({ ...(e.state || {}), ...mark(to.pushed) }, '', to.href);
      }
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
    return { push: (href, from) => write('push', href, from), replace: (href) => write('replace', href), up };
  }

  // A board's fragment is &-joined keys: selectedCard=<key> (the focused card), openItemsCard=<topic id> (the selected
  // open-items pill), review=<PR number>, and a bare reply. The older #item=<key> reads as selectedCard.
  // → {selectedCard, openItemsCard, review, reply}, each null or false when absent.
  function fragmentOf(hash) {
    const out = { selectedCard: null, openItemsCard: null, review: null, reply: false };
    const decode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
    for (const part of String(hash).replace(/^#/, '').split('&')) {
      const eq = part.indexOf('=');
      const [k, v] = eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
      if (k === 'selectedCard' || k === 'item') out.selectedCard = decode(v) || null;
      else if (k === 'openItemsCard') out.openItemsCard = decode(v) || null;
      else if (k === 'review' && /^\d+$/.test(v)) out.review = Number(v);
      else if (k === 'reply') out.reply = true;
    }
    return out;
  }
  // hash with the named keys of changes replaced (null drops one) → the new fragment, '' for none. A #review= link is
  // alone in its fragment, so a change to a card or pill replaces it; reply is spent once the card is shown.
  function hashWith(hash, changes) {
    const now = fragmentOf(hash);
    const next = { selectedCard: now.selectedCard, openItemsCard: now.openItemsCard, ...changes };
    const parts = [];
    if (next.selectedCard) parts.push(`selectedCard=${encodeURIComponent(next.selectedCard)}`);
    if (next.openItemsCard) parts.push(`openItemsCard=${encodeURIComponent(next.openItemsCard)}`);
    return parts.length ? '#' + parts.join('&') : '';
  }

  return { viewOf, urlOf, mounted, entryOf, isPrototype, listen, fragmentOf, hashWith };
})();
