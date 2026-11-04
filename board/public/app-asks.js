// New tasks on the board view: the + sheet that sends one as an ask event, and bump, edit and delete for a New card or a
// pending thread message (docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md,
// docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md). Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, toast, quieted, sendDraft } = B;
  const { attachButton, waitOn } = BoardUI;

  // The ask box is a bottom sheet: a <dialog> opened from the + button. Closing keeps the draft.
  const sheet = $('#sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  if (!$('#askForm .row .attach')) $('#askForm .row').insertAdjacentHTML('afterbegin', attachButton());
  // Files picked before the app shell switched away from this board are still attached, so they show again.
  BoardAttach.paint('ask', B.site.root);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (!$('#askForm .send-hint')) $('#askForm button[type=submit]').insertAdjacentHTML('beforebegin', `<span class="send-hint" aria-hidden="true">${isMac ? '⌘↵' : 'Ctrl+↵'}</span>`);
  // ⌘↵ (Ctrl+↵ off a Mac) sends from any composer: the ask, a thread reply, an edit.
  B.on(B.root, 'keydown', (ev) => {
    if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.isComposing) return;
    const form = ev.target instanceof HTMLTextAreaElement ? ev.target.closest('form[data-composer], form.edit-form') : null;
    if (!form) return;
    ev.preventDefault();
    form.requestSubmit();
  });
  $('#askText').value = store.get('draft:ask', '');
  B.on($('#askText'), 'input', (e) => { if (!quieted('draft:ask', e.target)) store.set('draft:ask', e.target.value); });
  let stopFitting = null;
  const stopFit = () => { stopFitting?.(); stopFitting = null; };
  B.on(sheet, 'close', stopFit);
  B.atUnmount(stopFit);
  function openSheet() {
    if (sheet.open) return;
    stopFit();
    stopFitting = BoardDialogs.fitSheet(sheet);
    sheet.classList.remove('closing');
    sheet.showModal();
    $('#askText').focus();
    $('#compose').setAttribute('aria-expanded', 'true');
  }
  function closeSheet() {
    if (!sheet.open || sheet.classList.contains('closing')) return;
    $('#compose').setAttribute('aria-expanded', 'false');
    if (reduceMotion.matches) { sheet.close(); return; }
    sheet.classList.add('closing');
    B.later(180, () => { sheet.classList.remove('closing'); sheet.close(); });
  }
  B.on($('#compose'), 'click', openSheet);
  // n pressed twice opens the sheet, as the + button's tooltip says, unless a field or another dialog has focus. With
  // nothing focused the key goes to <body>, outside the view, so this listens on the document. A key switch mode
  // used (sidebar.js) comes defaultPrevented and doesn't count.
  const TWICE_MS = 500;
  let lastN = -Infinity;
  B.on(document, 'keydown', (ev) => {
    if (ev.defaultPrevented) { lastN = -Infinity; return; }
    if (ev.key !== 'n' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || ev.isComposing) return;
    const field = ev.target instanceof Element && ev.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (field || document.querySelector('dialog[open]') || B.root.classList.contains('offline')) { lastN = -Infinity; return; }
    if (ev.timeStamp - lastN > TWICE_MS) { lastN = ev.timeStamp; return; }
    lastN = -Infinity;
    ev.preventDefault();
    openSheet();
  });
  B.on($('#sheetClose'), 'click', closeSheet);
  B.on(sheet, 'click', (ev) => { if (ev.target === sheet) closeSheet(); });
  B.on(sheet, 'cancel', (ev) => { ev.preventDefault(); closeSheet(); });
  // Discuss or Quick build, above Send: Discuss, the default, has the session grill or prototype the task at once; Quick
  // build sends the ask with quick: true, and the session marks the card ready. Each send goes back to Discuss
  // (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
  const CHOICE_HELP = {
    discuss: 'Discuss: Claude grills or prototypes it first, then waits for you.',
    quick: 'Quick build: for changes you’re sure about; Claude marks it ready and builds.',
  };
  let quick = false;
  function choose(isQuick) {
    quick = isQuick;
    $('#askDiscuss').setAttribute('aria-pressed', String(!quick));
    $('#askQuick').setAttribute('aria-pressed', String(quick));
    $('#askChoiceHelp').textContent = CHOICE_HELP[quick ? 'quick' : 'discuss'];
  }
  choose(false);
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('#askDiscuss, #askQuick');
    if (b) choose(b.id === 'askQuick');
  });
  B.on($('#askForm'), 'submit', async (ev) => {
    ev.preventDefault();
    $('#askText').blur();
    const text = $('#askText').value.trim();
    const files = BoardAttach.files('ask', B.site.root);
    if ((!text && !files.length) || BoardAttach.busy('ask', B.site.root)) return;
    $('#askStatus').textContent = '';
    try {
      await waitOn($('#askForm button[type="submit"]'), sendDraft('draft:ask', $('#askText'), () => $('#askText'), () => B.send('ask', { text, ...(files.length ? { files } : {}), ...(quick ? { quick: true } : {}) })));
      BoardAttach.clear('ask', B.site.root);
      choose(false);
      $('#askStatus').textContent = '';
      closeSheet();
      toast('Sent');
    } catch { $('#askStatus').textContent = 'Could not send'; }
  });

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
