// An item's notes, /<route>/notes.html?item=<file>/<id>, a view of the app shell (shell.js)
// (docs/adr/2026-10-29-1816-notes-replace-the-full-plan-and-cards-start-on-their-own.md). Back goes to the item's card.
(globalThis.AppViews ||= {}).notes = {
  className: 'view-notes',
  title: () => 'Notes',
  markup: ({ item }) => `${BoardUI.header({ lead: 'back', title: 'Notes', titleId: 'ref', backHref: `./#selectedCard=${encodeURIComponent(item || '')}`, controls: false })}
<main>
  <article class="plan" id="plan"><p class="muted">Loading the notes…</p></article>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, async (B) => {
    const { $, site } = B;
    const { esc, markdown, linkContext, fetchJSON, downLanding, copyNote, pageCopy } = BoardUI;
    const key = ctx.view.item || '';
    const el = $('#plan');
    const get = (url, opts = {}) => fetchJSON(url, { ...opts, sleep: B.sleep });
    const paint = (body, items, note = '') => {
      $('#ref').textContent = `${body.ref} notes`;
      document.title = $('#ref').textContent;
      el.innerHTML = note + markdown(body.markdown, linkContext(items, key, { base: './' }));
    };
    // While the board can't be reached, the notes' last answer here shows under its copy line, or with none the landing
    // for why (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md).
    const url = site.url(`api/notes?item=${encodeURIComponent(key)}`);
    let copy = null;
    let live = false;
    let copied = false;
    const waiting = (down) => {
      copy ||= pageCopy.read(url);
      copy.then((c) => {
        if (!B.alive() || live || copied) return;
        if (!c) { el.innerHTML = downLanding(down); return; }
        copied = true;
        paint(c.body, [], copyNote('the notes', c.savedAt));
      });
    };
    try {
      const board = get(site.url('api/board')).then((r) => r.body).catch(() => ({}));
      const r = await get(url, { onWait: (ms, down) => waiting(down) });
      if (!B.alive()) return;
      if (!r.ok) throw new Error(r.body.error || `notes ${r.status}`);
      live = true;
      paint(r.body, (await board).items || []);
      pageCopy.save(url, r.body);
    } catch (e) {
      if (e.down) waiting(e.down);
      else el.innerHTML = `<p class="muted">Could not load these notes: ${esc(e.message)}</p>`;
    }
  }),
};
