// New tasks on the board view: the New strip above the lanes, with edit and delete for an ask the orchestrator has yet to
// ingest and Dismiss for one it has (docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md,
// docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md). A thread message has neither
// (docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md).
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

  // An ask in the New strip carries its card's key.
  function pendingAsk(b, id) {
    const key = b.closest('.new-entry')?.dataset.key || undefined;
    return { key, data: { id, ...(key ? { key } : {}) } };
  }
  // An edit box lives in state.edits and the New strip draws it (ui-cards.js newStrip), so a repaint keeps it, and so
  // does leaving the board and opening it again in this page.
  for (const [id, e] of B.place?.edits || []) state.edits.set(id, e);
  B.keep(() => ({ edits: [...state.edits] }));
  function closeEditor(id) {
    if (!state.edits.delete(id)) return;
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
      const { key, data } = pendingAsk(eb, id);
      if (!key || state.edits.has(id)) return;
      state.edits.set(id, { key, data, text: state.board.items.find((i) => i.key === key).ask.text });
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
    const { data } = pendingAsk(del, id);
    // One request records the withdrawal and hides the ask, and its card leaves once it has
    // (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
    try {
      await waitOn(del, B.send('ask-withdrawn', data));
      state.edits.delete(id);
      BoardAttach.clear('edit:' + id, B.site.root);
      toast('Deleted');
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
    // show in the New strip and the card's thread, and a refusal leaves the box as it was
    // (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
    e.text = text;
    try {
      await waitOn(form.querySelector('button[type="submit"]'), B.send('ask-edited', { ...e.data, text, ...(files.length ? { files } : {}) }));
    } catch (err) { B.failed(err); return; }
    closeEditor(id);
    BoardAttach.clear(form.dataset.composer, B.site.root);
    toast('Edited');
    B.loadThread(e.key, { force: true });
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
