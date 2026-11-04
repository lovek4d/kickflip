// New tasks on the board view: bump, edit and delete for a New card or a
// pending thread message (docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md,
// docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md). Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, state, toast } = B;
  const { waitOn } = BoardUI;

  // ⌘↵ (Ctrl+↵ off a Mac) sends a thread reply or an edit from its box; the ask's own is new-task.js's.
  B.on(B.root, 'keydown', (ev) => {
    if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.isComposing) return;
    const form = ev.target instanceof HTMLTextAreaElement ? ev.target.closest('form[data-reply], form.edit-form') : null;
    if (!form) return;
    ev.preventDefault();
    form.requestSubmit();
  });
  BoardNewTask.wire(B);

  // A bump moves the New card to the top once the server has recorded it, button (its icon, or the prototype button
  // that bumps it) waiting meanwhile (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
  async function bumpAsk(id, button) {
    try { await waitOn(button, B.send('ask-bump', { id })); toast('Bumped to the top'); } catch (e) { B.failed(e); }
  }
  B.on(B.root, 'click', (ev) => {
    const bump = ev.target.closest('button[data-bump]');
    if (!bump) return;
    ev.preventDefault();
    bumpAsk(bump.dataset.bump, bump);
  });
  B.bumpAsk = bumpAsk;
  // A New card's icons sit on the card; a message in a thread, an ask's included, carries its thread's key.
  async function pendingMessage(b, id) {
    const card = b.closest('details.item');
    const thread = b.closest('[data-thread]')?.dataset.thread || card?.querySelector('[data-thread]')?.dataset.thread || card?.dataset.key || null;
    const key = thread && thread !== `ask:${id}` ? thread : undefined;
    let msg = b.closest('.msg');
    if (!msg && b.dataset.edit && card) {
      card.open = true;
      for (let i = 0; i < 30 && !msg; i++) { msg = card.querySelector(`.msg[data-event="${CSS.escape(id)}"]`); if (!msg) await new Promise((r) => setTimeout(r, 100)); }
    }
    return { thread, key, msg, data: { id, ...(key ? { key } : {}) } };
  }
  // An edit box lives in state.edits and its thread draws it (ui-threads.js threadMessages), so a repaint keeps it, and
  // so does leaving the board and opening it again in this page.
  for (const [id, e] of B.place?.edits || []) state.edits.set(id, e);
  B.keep(() => ({ edits: [...state.edits] }));
  function closeEditor(id) {
    const e = state.edits.get(id);
    state.edits.delete(id);
    if (e) B.repaintThread(e.thread);
  }
  B.on(B.root, 'input', (ev) => {
    const e = state.edits.get(ev.target.closest?.('form[data-edit-form]')?.dataset.editForm);
    if (e) e.text = ev.target.value;
  });
  B.on(B.root, 'click', async (ev) => {
    const eb = ev.target.closest('button[data-edit]');
    if (eb) {
      ev.preventDefault();
      const id = eb.dataset.edit;
      const { thread, msg, data } = await pendingMessage(eb, id);
      if (!msg || !thread || state.edits.has(id)) return;
      const text = (state.threadCache.get(thread) || []).find((m) => m.eventId === id)?.text ?? msg.querySelector('.body').textContent;
      state.edits.set(id, { thread, data, text });
      B.repaintThread(thread);
      $(`form[data-edit-form="${CSS.escape(id)}"] textarea`)?.focus();
      return;
    }
    const cancel = ev.target.closest('.edit-form button[data-edit-cancel]');
    if (cancel) {
      const id = cancel.closest('form').dataset.editForm;
      closeEditor(id);
      BoardAttach.clear('edit:' + id, B.site.root);
      return;
    }
    const del = ev.target.closest('button[data-withdraw]');
    if (!del) return;
    ev.preventDefault();
    if (!(await B.confirm('Delete this message? Claude will skip it.'))) return;
    const id = del.dataset.withdraw;
    const { key, msg } = await pendingMessage(del, id);
    // One request records the withdrawal and hides the message, and the card or message leaves once it has
    // (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
    try {
      await waitOn(del, B.send('ask-withdrawn', { id, ...(key ? { key } : {}) }));
      state.edits.delete(id);
      BoardAttach.clear('edit:' + id, B.site.root);
      if (msg) msg.hidden = true;
      toast('Deleted');
      if (key) B.loadThread(key, { force: true });
    } catch (e) { B.failed(e); }
  });
  B.on(B.root, 'submit', async (ev) => {
    const form = ev.target.closest('form.edit-form');
    if (!form) return;
    ev.preventDefault();
    const id = form.dataset.editForm;
    const e = state.edits.get(id);
    if (!e) return;
    const text = form.querySelector('textarea').value.trim();
    if (!text) { toast('Write something, or delete the message'); return; }
    if (BoardAttach.busy(form.dataset.composer, B.site.root)) return;
    const files = BoardAttach.files(form.dataset.composer, B.site.root);
    // The edit box stays open, its Save waiting, until the server has recorded the edit; then the new text and files
    // show, in the thread and on the New card, and a refusal leaves the box as it was
    // (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
    e.text = text;
    try {
      await waitOn(form.querySelector('button[type="submit"]'), B.send('ask-edited', { ...e.data, text, ...(files.length ? { files } : {}) }));
    } catch (err) { B.failed(err); return; }
    const before = state.threadCache.get(e.thread);
    if (before) state.threadCache.set(e.thread, before.map((m) => (m.eventId === id ? { ...m, text, edited: true, files: [...(m.files || []), ...files] } : m)));
    closeEditor(id);
    BoardAttach.clear(form.dataset.composer, B.site.root);
    toast('Edited');
    B.loadThread(e.thread, { force: true });
  });
  // The asks watch polls every 10 s while an ask waits for its reply, sooner than the board's own refresh.
  let asksSeen = false;
  B.watch((list) => {
    if (!list) return;
    if (asksSeen) B.loadBoard();
    asksSeen = true;
  }, { kind: 'ask', limit: 50 });
});
