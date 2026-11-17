// Every page's header, for the board pages and the hub's pages alike. It needs nothing else, since board/server.mjs
// renders each board page's <!--header {…}--> with it and hub/hub.mjs renders the hub's headers, each in a vm context.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (size, paths) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ARROW = icon(24, '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>');
  const REFRESH = icon(18, '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>');
  const GEAR = icon(18, '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>');
  const MOON = icon(16, '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');
  const BULB = icon(18, '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>');
  // The pages switch (docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md): a bare ? and a bare check, drawn
  // like the bulb and gear.
  const QUESTION = icon(18, '<path d="M6.5 8.5a5.5 5.5 0 1 1 8.2 4.8c-1.6.9-2.7 1.8-2.7 3.2V17"/><path d="M12 21h.01"/>');
  const CHECK = icon(18, '<path d="M20 6 9 17l-5-5"/>');
  const id = (v) => (v ? ` id="${esc(v)}"` : '');

  // Where the back arrow goes (docs/adr/2026-10-29-1639-a-questions-takes-show-inline.md): 'back', one step back in history, when
  // the page before was on this hub; else 'href', its backHref. A page a push opened always takes its backHref. idx is
  // the entry's index in history.state, set by an in-app router: when present, it alone says whether a step back exists.
  function backStep({ pushed = false, referrer = '', href, depth = 1, idx }) {
    if (pushed) return 'href';
    if (Number.isInteger(idx)) return idx > 0 ? 'back' : 'href';
    let ref = null;
    try { ref = referrer ? new URL(referrer) : null; } catch { ref = null; }
    return ref && ref.origin === new URL(href).origin && ref.href !== href && depth > 1 ? 'back' : 'href';
  }

  // Runs in the page as the header's own script, so it uses nothing outside itself and step. The push mark lives in
  // sessionStorage, since prototype-switcher.js drops from=push (board/store.mjs pushUrl) from the URL; a reload keeps it.
  function wireBack(step) {
    const key = 'from-push:' + location.pathname;
    let pushed = new URLSearchParams(location.search).get('from') === 'push';
    try {
      if (pushed) sessionStorage.setItem(key, '1');
      else if (performance.getEntriesByType('navigation')[0]?.type === 'navigate') sessionStorage.removeItem(key);
      pushed = sessionStorage.getItem(key) === '1';
    } catch { /* no storage: only this load knows */ }
    const target = () => step({ pushed, referrer: document.referrer, href: location.href, depth: history.length, idx: history.state?.idx });
    globalThis.PageBack = { pushed, target };
    document.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || !e.target.closest?.('a.back') || target() !== 'back') return;
      e.preventDefault();
      history.back();
    });
  }

  // lead is 'logo' (the kickflip, which toggles the sidebar, sidebar.js; logoHref, the hub's page, without it)
  // or 'back' (the arrow, which follows backStep, with backHref the work item or the board, after the logo). The controls (time and refresh) paint disabled with refresh spinning until the
  // page's script turns them on (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md). With controls
  // false, trail (HTML) takes their place; navAfter (HTML) goes after the controls, before the ?. pages is the switch between a board's two pages
  // (docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md): 'questions' puts the ? after the controls, with
  // the open-question count in its badge (app-header.js), and 'board' puts the check, back up to the board, after trail. leadAttrs adds to or replaces the lead link's attributes, and level is the
  // title's heading level, for a header that isn't the page's own, such as the sidebar's (ui-sidebar.js). titleMenu (HTML) makes the
  // title the button that opens it, the board menu (app-header.js), and goes after the title and its moon. moon puts the
  // away moon right of the title, hidden until app-header.js renderStatus shows it (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md).
  function header({ lead = 'logo', title = '', titleId, backHref = './', backLabel = 'Back to the board', backId, logoSrc = 'kickflip.png',
    controls = true, trail = '', time = '…', pages = null, moon = false, logoHref = '/_hub/', leadAttrs = {}, level = 1, navAfter = '', titleMenu = '' } = {}) {
    const attrs = (base) => Object.entries({ ...base, ...leadAttrs }).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const logo = (cls = 'hub') => `<a class="${cls}" href="${esc(logoHref)}"${attrs({ 'aria-label': 'Boards' })}><img src="${esc(logoSrc)}" alt=""></a>`;
    const first = lead === 'back'
      ? `${logo('hub')}<a class="back" href="${esc(backHref)}"${id(backId)}${attrs({ 'aria-label': backLabel })}>${ARROW}</a>`
      : logo();
    const nav = controls ? `<nav class="nav">`
      + `<span class="refresh"><button class="ghost spinning" id="refresh" type="button" disabled aria-label="Refresh" title="Refresh">${REFRESH}</button><span class="muted" id="status">${esc(time)}</span></span>${navAfter}`
      + (pages === 'questions' ? `<a href="questions.html" id="questionsLink" class="ghost icon pages-switch" aria-label="Open questions" title="Open questions">${QUESTION}<span class="q-badge" hidden></span></a>` : '')
      + `</nav>` : trail + (pages === 'board' ? `<a class="ghost icon pages-switch back" href="./" aria-label="Back to the board" title="Back to the board">${CHECK}</a>` : '');
    const script = lead === 'back' ? `<script>(${wireBack})(${backStep});</script>` : '';
    const h = `h${[1, 2, 3, 4, 5, 6].includes(level) ? level : 1}`;
    const away = moon ? `<span class="away-moon" role="img" aria-label="Away" aria-hidden="true">${MOON}</span>` : '';
    const named = titleMenu ? `<button type="button" class="title-menu" id="boardMenuOpen" aria-haspopup="menu" aria-expanded="false" aria-controls="boardMenu">${esc(title)}</button>` : esc(title);
    return `<header class="top"><div class="brand">${first}<${h}${id(titleId)}>${named}</${h}>${away}${titleMenu}</div>${nav}</header>${script}`;
  }

  // The foot of the board, under the lanes: the architecture review's bulb (app-arch.js) and the gear, Board Settings,
  // which paints disabled until app-header.js turns it on with the header's controls. It starts hidden; the first render
  // of the lanes shows it (app.js render).
  const boardFoot = () => '<div class="board-foot" hidden>'
    + `<button class="ghost icon arch-bulb" id="archBulb" type="button" aria-label="Architecture review" title="Architecture review" aria-haspopup="dialog">${BULB}</button>`
    + `<a href="settings.html" id="settingsLink" class="ghost icon" aria-label="Settings" title="Settings" aria-disabled="true" tabindex="-1" aria-haspopup="dialog">${GEAR}</a>`
    + '</div>';

  Object.assign(globalThis.BoardUI ||= {}, { header, backStep, boardFoot });
})();
