// Any other page on the hub as a view of the app shell (shell.js): another site, a prototype, or a board page that isn't
// a view of its own, in a same-origin frame under the board header (docs/adr/0055-one-app-for-the-whole-hub.md). The
// header's title follows the page's, and Open alone ↗ loads the page by itself (?alone=1, hub/shell.mjs pageOf). A
// page that draws the board header itself, such as a prototype or another site's page, hides this one; its logo then
// toggles the sidebar as this one's would, and hides while the rail shows. The page's own navigations stay in the frame
// and in the browser's history; each load hands its URL and title to the shell. A tap in the frame on a link to any
// other view, the page's own back arrow included, goes to the shell.
// ctx, from shell.js: {view, siteTitle, boards() → board routes, open(href) shows a URL in the shell or loads it,
// toggleSidebar(), loaded(url, title) after each load}.
(function () {
  // sidebar.js's rail.
  const RAIL = '(min-width: 1000px)';
  const LOGO_CSS = '<style id="hub-frame-logo">html.hub-rail body > header.top a.hub { display: none; }</style>';
  const alone = (url) => {
    const u = new URL(url, location.href);
    u.searchParams.set('alone', '1');
    return u.pathname + u.search + u.hash;
  };

  (globalThis.AppViews ||= {}).frame = {
    className: 'view-frame',
    title: (view, { siteTitle }) => siteTitle,
    markup: (view, { siteTitle }) => {
      const { esc, header } = BoardUI;
      const open = `<nav class="nav"><a class="alone" href="${esc(alone(view.url))}" target="_blank" rel="noopener">Open alone ↗</a></nav>`;
      return `${header({ lead: 'logo', title: siteTitle, logoSrc: '/_hub/kickflip.png', controls: false, trail: open })}
<iframe class="frame-page" src="${esc(view.url)}" title="${esc(siteTitle)}"></iframe>`;
    },

    create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, (B) => {
      const frame = B.$('iframe.frame-page');
      const heading = B.$(':scope > .top h1');
      const openAlone = B.$(':scope > .top a.alone');
      const rail = matchMedia(RAIL);
      let shown = null;
      const syncLogo = () => shown?.documentElement.classList.toggle('hub-rail', rail.matches && !document.documentElement.classList.contains('sb-collapsed'));
      B.on(rail, 'change', syncLogo);
      const collapse = new MutationObserver(syncLogo);
      collapse.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      B.atUnmount(() => collapse.disconnect());

      function tap(e, win) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (e.target.closest?.('body > header.top a.hub')) { e.preventDefault(); ctx.toggleSidebar(); return; }
        const a = e.target.closest?.('a[href]');
        if (!a || a.hasAttribute('download') || !['', '_self', '_top', '_parent'].includes(a.target)) return;
        const view = AppRouter.viewOf(a.href, { boards: ctx.boards() });
        if (!view) return;
        const to = new URL(a.href);
        if (to.pathname === win.location.pathname && to.search === win.location.search && to.hash) return;
        // The page's own back arrow (ui-page-header.js) already went back when a page before it is in this frame.
        const back = a.classList.contains('back') && Boolean(a.closest('header.top'));
        if (!back && view.kind === 'frame' && (a.target || '_self') === '_self') return;
        e.preventDefault();
        if (back && BoardUI.backStep({ pushed: history.state?.pushed === true, href: location.href, idx: history.state?.idx }) === 'back') history.back();
        else ctx.open(a.href);
      }

      B.on(frame, 'load', () => {
        let win = null;
        let doc = null;
        try {
          win = frame.contentWindow;
          doc = win.document;
          if (win.location.href === 'about:blank') return;
        } catch { return; /* another origin: the page is its own */ }
        const title = doc.title || ctx.siteTitle;
        heading.textContent = title;
        frame.title = title;
        const url = win.location.pathname + win.location.search + win.location.hash;
        openAlone.href = alone(url);
        root.classList.toggle('own-header', Boolean(doc.querySelector('body > header.top')));
        if (!doc.getElementById('hub-frame-logo')) doc.head?.insertAdjacentHTML('beforeend', LOGO_CSS);
        shown = doc;
        syncLogo();
        B.on(doc, 'click', (e) => tap(e, win));
        ctx.loaded(url, title);
      });
    }),
  };
})();
