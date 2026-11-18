// docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md
// The board server adds this to each HTML page of the site's own public/ (a visual, a hand-written page), which runs in
// an opaque origin, so the reader sheet framing it (app-reader.js framedPage) can't read its title or see its link
// taps. It sends them: {kickflip: 'page', title} once loaded, and {kickflip: 'page-link', href} for a plain tap on a
// link that would open in this frame, but for one to a place on this page, whose opening the sheet decides. Alone,
// the page is left as it is.
(function () {
  if (parent === window) return;
  const send = (message) => parent.postMessage(message, '*');
  addEventListener('load', () => send({ kickflip: 'page', title: document.title }));
  addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('download') || !['', '_self', '_top', '_parent'].includes(a.target)) return;
    const [to, hash] = a.href.split('#');
    if (hash !== undefined && to === location.href.split('#')[0]) return;
    e.preventDefault();
    send({ kickflip: 'page-link', href: a.href });
  });
})();
