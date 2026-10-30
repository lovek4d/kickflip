// An item's notes, /<route>/notes.html?item=<wave>/<id>, a view of the app shell (shell.js)
// (docs/adr/0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md). Back goes to the item's card.
(globalThis.AppViews ||= {}).notes = {
  className: 'view-notes',
  title: () => 'Notes',
  markup: ({ item }) => `${BoardUI.header({ lead: 'back', title: 'Notes', titleId: 'ref', backHref: `./#item=${encodeURIComponent(item || '')}`, controls: false })}
<main>
  <article class="plan" id="plan"><p class="muted">Loading the notes…</p></article>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, async (B) => {
    const { $, site } = B;
    const { esc, markdown, linkContext, fetchJSON, restartNotice } = BoardUI;
    const key = ctx.view.item || '';
    const el = $('#plan');
    const get = (url, opts = {}) => fetchJSON(url, { ...opts, sleep: B.sleep });
    try {
      const board = get(site.url('api/board')).then((r) => r.body).catch(() => ({}));
      const r = await get(site.url(`api/notes?item=${encodeURIComponent(key)}`), { onWait: () => { el.innerHTML = restartNotice(); } });
      if (!B.alive()) return;
      if (!r.ok) throw new Error(r.body.error || `notes ${r.status}`);
      $('#ref').textContent = `${r.body.ref} notes`;
      document.title = `${r.body.ref} notes`;
      el.innerHTML = markdown(r.body.markdown, linkContext((await board).items || [], key, { base: './' }));
    } catch (e) {
      el.innerHTML = `<p class="muted">Could not load these notes: ${esc(e.message)}</p>`;
    }
  }),
};
