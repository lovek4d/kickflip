// New tasks on the board view: the New strip above the lanes, with edit and delete for an ask the orchestrator has yet to
// ingest and Dismiss for one it has (docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md,
// docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md). A thread message has neither
// (docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md).
// Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, state, toast, seen, markRead } = B;
  const { keyedSend } = BoardUI;

  // The tasks the page hasn't sent yet follow the board's, in the order they were sent (app-threads.js unsentAsks).
  function renderNew(d) {
    const entries = [...BoardUI.newEntries(d, seen), ...B.unsentAsks(d)];
    const el = $('#newStrip');
    el.hidden = !entries.length;
    BoardUI.setHTML(el, entries.length ? BoardUI.newStrip(entries, state.edits, { open: B.store.get('lanes', {}), words: B.searchWords() }) : '');
  }
  // Dismiss, or following the entry's link to its card, marks the card read at the ingest, on every device, so the
  // entry leaves. The strip repaints after the click, so the browser follows the link as it was drawn.
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('[data-dismiss-new]');
    if (!b) return;
    // A link to a card the filter hides stays in the strip until its card opens (app.js showHidden).
    const card = b.tagName === 'A' && state.board?.items.find((i) => i.key === b.dataset.dismissNew);
    if (card && B.hiddenOnBoard(card)) return;
    markRead([[b.dataset.dismissNew, b.dataset.at]]);
    B.later(0, () => renderNew(state.board));
  });

  // ⌘↵ and ⌥↵ press a thread reply's or an edit's send buttons from its box (ui.js keyedSend); the ask's own are new-task.js's.
  B.on(B.root, 'keydown', (ev) => {
    const form = ev.target.tagName === 'TEXTAREA' ? ev.target.closest('form[data-reply], form.edit-form') : null;
    const request = form && BoardUI.keyedRequest(ev, form);
    if (request) { ev.preventDefault(); request.click(); return; }
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
  const askText = (key) => state.board.items.find((i) => i.key === key)?.ask?.text || '';
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
    const del = ev.target.closest('button[data-withdraw]');
    if (!del) return;
    ev.preventDefault();
    if (!(await B.confirm('Delete this message? Claude will skip it.'))) return;
    const id = del.dataset.withdraw;
    const { key, data } = pendingAsk(del, id);
    // The withdrawal goes through the outbox, its row in the New strip until the board has it; then the ask hides and
    // its card leaves (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md).
    closeEditor(id);
    BoardAttach.clear('edit:' + id, B.site.root);
    B.enqueue(undefined, { kind: 'ask-withdrawn', fields: data, said: `Deleted: ${askText(key)}` });
  });
  const revert = (id) => {
    closeEditor(id);
    BoardAttach.clear('edit:' + id, B.site.root);
  };
  // Focus leaving the form saves its edit (docs/adr/2026-11-16-2000-edits-save-when-focus-leaves-them.md); focus moving
  // to the form's own attach button or file list doesn't. An emptied or unchanged text with no files reverts, as Escape
  // does, and an upload still running holds the save until focus leaves again.
  B.on(B.root, 'focusout', (ev) => {
    const form = ev.target.closest?.('form.edit-form');
    if (!form || (ev.relatedTarget && form.contains(ev.relatedTarget))) return;
    const id = form.dataset.editForm;
    const e = state.edits.get(id);
    if (!e) return;
    const text = form.querySelector('textarea').value.trim();
    const files = BoardAttach.files(form.dataset.composer, B.site.root);
    if (!text || (text === askText(e.key) && !files.length)) { revert(id); return; }
    if (BoardAttach.busy(form.dataset.composer, B.site.root)) return;
    // The edit goes through the outbox, its row in the New strip until the board has it; then the new text and files
    // show in the New strip and the card's thread
    // (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md).
    revert(id);
    B.enqueue(undefined, { kind: 'ask-edited', text, files, fields: e.data, said: `Edited to: ${text}` });
  });
  B.on(B.root, 'keydown', (ev) => {
    const form = ev.key === 'Escape' && ev.target.closest?.('form.edit-form');
    if (form) revert(form.dataset.editForm);
  });
  Object.assign(B, { renderNew });
});
