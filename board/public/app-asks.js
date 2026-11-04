// New tasks on the board view: the + sheet that sends one as an ask event, and bump, edit and delete for a New card or a
// pending thread message (docs/adr/0014-a-pending-ask-can-be-deleted-or-bumped.md,
// docs/adr/0047-the-plus-makes-a-new-card.md). Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, toast, quieted, sendDraft, hide } = B;
  const { attachButton } = BoardUI;

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
  B.on($('#askForm'), 'submit', async (ev) => {
    ev.preventDefault();
    $('#askText').blur();
    const text = $('#askText').value.trim();
    const files = BoardAttach.files('ask', B.site.root);
    if ((!text && !files.length) || BoardAttach.busy('ask', B.site.root)) return;
    $('#askStatus').textContent = 'Sending…';
    try {
      await sendDraft('draft:ask', $('#askText'), () => $('#askText'), () => B.send('ask', { text, ...(files.length ? { files } : {}) }));
      BoardAttach.clear('ask', B.site.root);
      $('#askStatus').textContent = '';
      closeSheet();
      toast('Sent');
    } catch { $('#askStatus').textContent = 'Could not send'; }
  });

  // A bump moves the New card to the top at once, its icon filling as it goes
  // (docs/adr/0151-every-owner-tap-the-server-can-apply-draws-at-once.md).
  async function bumpAsk(id) {
    const icon = `button[data-bump="${CSS.escape(id)}"]`;
    const at = new Date().toISOString();
    const sending = B.send('ask-bump', { id }, B.drawItem(`ask:${id}`, (it) => ({ ...it, bumpedAt: at, ask: { ...it.ask, bumpedAt: at } })));
    B.fadeBump(icon, true);
    try { await sending; toast('Bumped to the top'); } catch { B.fadeBump(icon, false); toast(B.FAILED); }
  }
  B.on(B.root, 'click', (ev) => {
    const bump = ev.target.closest('button[data-bump]');
    if (!bump) return;
    ev.preventDefault();
    bump.disabled = true;
    bumpAsk(bump.dataset.bump);
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
    state.edits.delete(id);
    BoardAttach.clear('edit:' + id, B.site.root);
    state.withdrawnAsks.add(id);
    B.render();
    if (msg) msg.hidden = true;
    try {
      await B.send('ask-withdrawn', { id, ...(key ? { key } : {}) });
      await hide(id, true);
      toast('Deleted');
      if (key) B.loadThread(key, { force: true });
    } catch { state.withdrawnAsks.delete(id); B.render(); if (msg) msg.hidden = false; toast(B.FAILED); }
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
    // The new text and files show at once, in the thread and on the New card; a failed save puts the old text back and
    // reopens the edit box with what was typed and attached (docs/adr/0151-every-owner-tap-the-server-can-apply-draws-at-once.md).
    const before = state.threadCache.get(e.thread);
    if (before) state.threadCache.set(e.thread, before.map((m) => (m.eventId === id ? { ...m, text, edited: true, files: [...(m.files || []), ...files] } : m)));
    closeEditor(id);
    const title = text.split('\n')[0];
    try {
      await B.send('ask-edited', { ...e.data, text, ...(files.length ? { files } : {}) }, B.drawItem(`ask:${id}`, (it) => ({ ...it, title, ask: { ...it.ask, text, edited: true } })));
      BoardAttach.clear(form.dataset.composer, B.site.root);
      toast('Edited');
      B.loadThread(e.thread, { force: true });
    } catch {
      if (before) state.threadCache.set(e.thread, before);
      state.edits.set(id, { ...e, text });
      B.repaintThread(e.thread);
      toast(B.FAILED);
    }
  });
  // The asks watch polls every 10 s while an ask waits for its reply, sooner than the board's own refresh.
  let asksSeen = false;
  B.watch((list) => {
    if (!list) return;
    if (asksSeen) B.loadBoard();
    asksSeen = true;
  }, { kind: 'ask', limit: 50 });
});
