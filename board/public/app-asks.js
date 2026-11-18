// New tasks on the board view: the New strip above the lanes, with delete for an ask the orchestrator has yet to
// ingest and Dismiss for one it has (docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md,
// docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md). A thread message has neither
// (docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md).
// Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, state, toast, seen, markRead } = B;
  const { keyedSend } = BoardUI;

  // The tasks the page hasn't sent yet follow the board's, in the order they were sent (app-threads.js unsentAsks). An
  // ask the owner deleted reads deleting… on its own row (app-threads.js deletingIn), unless its own send failed.
  function renderNew(d) {
    const deleting = B.deletingIn(d);
    const entries = [...BoardUI.newEntries(d, seen), ...B.unsentAsks(d)]
      .map((e) => ((e.ask || e.withdraw) && deleting(e.id) ? { ...e, deleting: deleting(e.id) } : e));
    const el = $('#newStrip');
    el.hidden = !entries.length;
    BoardUI.setHTML(el, entries.length ? BoardUI.newStrip(entries, { open: B.store.get('lanes', {}), words: B.searchWords() }) : '');
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

  // ⌘↵ and ⌥↵ press a thread reply's send buttons from its box (ui.js keyedSend); the ask's own are new-task.js's.
  B.on(B.root, 'keydown', (ev) => {
    const form = ev.target.tagName === 'TEXTAREA' ? ev.target.closest('form[data-reply]') : null;
    const request = form && BoardUI.keyedRequest(ev, form);
    if (request) { ev.preventDefault(); request.click(); return; }
    const button = form && keyedSend(ev, form);
    if (!button) return;
    ev.preventDefault();
    form.requestSubmit(button);
  });
  BoardNewTask.wire(B);

  // An ask in the New strip carries its card's key; one the board doesn't have yet has none, and its id is its send id,
  // which the board stores the ask under.
  B.on(B.root, 'click', async (ev) => {
    const del = ev.target.closest('button[data-withdraw]');
    if (!del) return;
    ev.preventDefault();
    if (!(await B.confirm('Delete this message? Claude will skip it.'))) return;
    const key = del.closest('.new-entry')?.dataset.key || undefined;
    // The withdrawal goes through the outbox, behind the ask's own send, and marks the ask's row deleting… until the
    // board drops the ask; then the ask hides and its card leaves
    // (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md,
    // docs/adr/2026-11-18-2330-deleting-a-new-ask-reads-deleting-on-its-own-row.md).
    B.enqueue(undefined, { kind: 'ask-withdrawn', fields: { id: del.dataset.withdraw, ...(key ? { key } : {}) } });
  });
  Object.assign(B, { renderNew });
});
