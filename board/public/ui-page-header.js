// Every page's header, for the board pages and the hub's pages alike. It needs nothing else, since board/server.mjs
// renders each board page's <!--header {…}--> with it and hub/hub.mjs renders the hub's headers, each in a vm context.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (size, paths) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ARROW = icon(24, '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>');
  const REFRESH = icon(18, '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>');
  const GEAR = icon(18, '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>');
  const BULB = icon(18, '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>');
  const id = (v) => (v ? ` id="${esc(v)}"` : '');

  // Where the back arrow goes (docs/adr/0048-a-questions-takes-show-inline.md): 'back', one step back in history, when
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
  // or 'back' (the arrow, which follows backStep, with backHref the work item or the board, beside a phone-only logo). The controls (time and refresh, gear) paint disabled with refresh spinning until the
  // page's script turns them on (docs/adr/0021-the-board-shows-github-checks-and-watcher-health.md). With controls
  // false, trail (HTML) takes their place. bulb puts the architecture review's bulb between them (app-arch.js). leadAttrs adds to or replaces the lead link's attributes, and level is the
  // title's heading level, for a header that isn't the page's own, such as the sidebar's (ui-sidebar.js).
  function header({ lead = 'logo', title = '', titleId, backHref = './', backLabel = 'Back to the board', backId, logoSrc = 'kickflip.png',
    controls = true, trail = '', time = '…', bulb = false, settingsHref = 'settings.html', logoHref = '/_hub/', leadAttrs = {}, level = 1 } = {}) {
    const attrs = (base) => Object.entries({ ...base, ...leadAttrs }).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    const logo = (cls = 'hub') => `<a class="${cls}" href="${esc(logoHref)}"${attrs({ 'aria-label': 'Boards' })}><img src="${esc(logoSrc)}" alt=""></a>`;
    const first = lead === 'back'
      ? `<a class="back" href="${esc(backHref)}"${id(backId)}${attrs({ 'aria-label': backLabel })}>${ARROW}</a>${logo('hub phone-logo')}`
      : logo();
    const nav = controls ? `<nav class="nav">`
      + `<span class="refresh"><button class="ghost spinning" id="refresh" type="button" disabled aria-label="Refresh" title="Refresh">${REFRESH}</button><span class="muted" id="status">${esc(time)}</span></span>`
      + (bulb ? `<button class="ghost icon arch-bulb" id="archBulb" type="button" aria-label="Architecture review" title="Architecture review" aria-haspopup="dialog">${BULB}</button>` : '')
      + (settingsHref ? `<a href="${esc(settingsHref)}" id="settingsLink" class="ghost icon" aria-label="Settings" title="Settings" aria-disabled="true" tabindex="-1" aria-haspopup="dialog">${GEAR}</a>` : '')
      + `</nav>` : trail;
    const script = lead === 'back' ? `<script>(${wireBack})(${backStep});</script>` : '';
    const h = `h${[1, 2, 3, 4, 5, 6].includes(level) ? level : 1}`;
    return `<header class="top"><div class="brand">${first}<${h}${id(titleId)}>${esc(title)}</${h}></div>${nav}</header>${script}`;
  }

  Object.assign(globalThis.BoardUI ||= {}, { header, backStep });
})();
