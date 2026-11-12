// New tasks on the board view: the New strip above the lanes, with edit and delete for an ask the orchestrator has yet to
// ingest and Dismiss for one it has (docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md), and edit
// and delete for a pending thread message (docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md).
// Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, state, toast, seen, markRead } = B;
  const { waitOn, keyedSend } = BoardUI;

  function renderNew(d) {
    const entries = BoardUI.newEntries(d, seen);
    const el = $('#newStrip');
    el.hidden = !entries.length;
    BoardUI.setHTML(el, entries.length ? BoardUI.newStrip(entries, state.edits) : '');
  }
  // Dismiss, or following the entry's link to its card, marks the card read at the ingest, on every device, so the
  // entry leaves.
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('[data-dismiss-new]');
    if (!b) return;
    markRead([[b.dataset.dismissNew, b.dataset.at]]);
    renderNew(state.board);
  });

  // ⌘↵ and ⌥↵ press a thread reply's or an edit's send buttons from its box (ui.js keyedSend); the ask's own are new-task.js's.
  B.on(B.root, 'keydown', (ev) => {
    const form = ev.target.tagName === 'TEXTAREA' ? ev.target.closest('form[data-reply], form.edit-form') : null;
    const button = form && keyedSend(ev, form);
    if (!button) return;
    ev.preventDefault();
    form.requestSubmit(button);
  });
  BoardNewTask.wire(B);

  // An ask in the New strip carries its card's key; a message in a thread, an ask's included, carries its thread's key.
  function pendingMessage(b, id) {
    const thread = b.closest('.new-entry')?.dataset.key || b.closest('[data-thread]')?.dataset.thread || null;
    const key = thread || undefined;
    return { thread, key, msg: b.closest('.msg'), data: { id, ...(key ? { key } : {}) } };
  }
  // An edit box lives in state.edits and its thread draws it (ui-threads.js threadMessages), so a repaint keeps it, and
  // so does leaving the board and opening it again in this page.
  for (const [id, e] of B.place?.edits || []) state.edits.set(id, e);
  B.keep(() => ({ edits: [...state.edits] }));
  function closeEditor(id) {
    const e = state.edits.get(id);
    state.edits.delete(id);
    if (!e) return;
    B.repaintThread(e.thread);
    renderNew(state.board);
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
      const { thread, msg, data } = pendingMessage(eb, id);
      if (!thread || state.edits.has(id)) return;
      const ask = msg ? null : state.board.items.find((i) => i.key === thread).ask;
      const text = ask ? ask.text : (state.threadCache.get(thread) || []).find((m) => m.eventId === id)?.text ?? msg.querySelector('.body').textContent;
      state.edits.set(id, { thread, data, text });
      B.repaintThread(thread);
      renderNew(state.board);
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
    const { key, msg } = pendingMessage(del, id);
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
    // show, in the thread or the New strip, and a refusal leaves the box as it was
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
  Object.assign(B, { renderNew });
  // The asks watch polls every 10 s while an ask waits for its reply, sooner than the board's own refresh.
  let asksSeen = false;
  B.watch((list) => {
    if (!list) return;
    if (asksSeen) B.loadBoard();
    asksSeen = true;
  }, { kind: 'ask', limit: 50 });
});
