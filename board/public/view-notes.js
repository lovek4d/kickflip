// An item's notes, /<route>/notes.html?item=<wave>/<id>, a view of the app shell (shell.js)
// (docs/adr/0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md). Back goes to the item's card.
// ?wave=<slug> shows a wave's goal, order and note instead, and back goes to the board.
(globalThis.AppViews ||= {}).notes = {
  className: 'view-notes',
  title: () => 'Notes',
  markup: ({ item, wave }) => `${BoardUI.header({ lead: 'back', title: 'Notes', titleId: 'ref', backHref: wave ? './' : `./#item=${encodeURIComponent(item || '')}`, controls: false })}
<main>
  <article class="plan" id="plan"><p class="muted">Loading the notes…</p></article>
</main>`,

  create: (root, siteRoot, ctx) => BoardView.page(root, siteRoot, async (B) => {
    const { $, site } = B;
    const { esc, markdown, linkContext, fetchJSON, restartNotice } = BoardUI;
    const key = ctx.view.item || '';
    const wave = ctx.view.wave;
    const el = $('#plan');
    const get = (url, opts = {}) => fetchJSON(url, { ...opts, sleep: B.sleep });
    try {
      const board = get(site.url('api/board')).then((r) => r.body).catch(() => ({}));
      const query = wave ? `wave=${encodeURIComponent(wave)}` : `item=${encodeURIComponent(key)}`;
      const r = await get(site.url(`api/notes?${query}`), { onWait: () => { el.innerHTML = restartNotice(); } });
      if (!B.alive()) return;
      if (!r.ok) throw new Error(r.body.error || `notes ${r.status}`);
      $('#ref').textContent = `${wave ? r.body.title : r.body.ref} notes`;
      document.title = $('#ref').textContent;
      el.innerHTML = markdown(r.body.markdown, linkContext((await board).items || [], key, { base: './' }));
    } catch (e) {
      el.innerHTML = `<p class="muted">Could not load these notes: ${esc(e.message)}</p>`;
    }
  }),
};
