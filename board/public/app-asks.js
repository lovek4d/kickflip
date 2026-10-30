// New tasks on the board view: the + sheet that sends one as an ask event, and bump, edit and delete for a New card or a
// pending thread message (docs/adr/0014-a-pending-ask-can-be-deleted-or-bumped.md,
// docs/adr/0047-the-plus-makes-a-new-card.md). Needs app-core.js and app-threads.js.
BoardView.part((B) => {
  const { $, store, state, typing, toast, quieted, sendDraft, hide } = B;
  const { esc, attachButton } = BoardUI;

  // The ask box is a bottom sheet: a <dialog> opened from the + button. Closing keeps the draft.
  const sheet = $('#sheet');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  if (!$('#askForm .row .attach')) $('#askForm .row').insertAdjacentHTML('afterbegin', attachButton());
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
  // iOS keeps fixed elements on the layout viewport, under the keyboard; this lifts the sheet to the visual viewport's bottom.
  const vv = window.visualViewport;
  function fitSheet() {
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    sheet.style.setProperty('--kb', kb + 'px');
    sheet.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');
    sheet.classList.toggle('kb', kb > 0);
  }
  B.on(vv, 'resize', fitSheet);
  B.on(vv, 'scroll', fitSheet);
  function openSheet() {
    if (sheet.open) return;
    fitSheet();
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
  // nothing focused the key goes to <body>, outside the view, so this listens on the document.
  const TWICE_MS = 500;
  let lastN = -Infinity;
  B.on(document, 'keydown', (ev) => {
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
    const files = BoardAttach.files('ask');
    if ((!text && !files.length) || BoardAttach.busy('ask')) return;
    $('#askStatus').textContent = 'Sending…';
    try {
      await sendDraft('draft:ask', $('#askText'), () => $('#askText'), () => B.site.send('ask', { text, ...(files.length ? { files } : {}) }));
      BoardAttach.clear('ask');
      $('#askStatus').textContent = '';
      closeSheet();
      toast('Sent', 2500);
      B.loadBoard();
    } catch { $('#askStatus').textContent = 'Could not send'; }
  });

  B.on(B.root, 'click', async (ev) => {
    const bump = ev.target.closest('button[data-bump]');
    if (!bump) return;
    ev.preventDefault();
    bump.disabled = true;
    try { await B.site.send('ask-bump', { id: bump.dataset.bump }); toast('Bumped to the top', 2500); } catch { toast('Could not bump', 3000); }
    B.loadBoard();
  });
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
  const closeEditor = (form) => { form.previousElementSibling.hidden = false; form.remove(); if (state.lanesStale && !typing()) B.render(); };
  B.on(B.root, 'click', async (ev) => {
    const eb = ev.target.closest('button[data-edit]');
    if (eb) {
      ev.preventDefault();
      const id = eb.dataset.edit;
      const { thread, msg, data } = await pendingMessage(eb, id);
      if (!msg || msg.querySelector('.edit-form')) return;
      const body = msg.querySelector('.body');
      const current = (state.threadCache.get(thread) || []).find((m) => m.eventId === id)?.text ?? body.textContent;
      body.hidden = true;
      body.insertAdjacentHTML('afterend', `<form class="edit-form" data-thread-key="${esc(thread || '')}" data-event='${esc(JSON.stringify(data))}'><textarea rows="3">${esc(current)}</textarea>
        <div class="row"><span></span><span><button type="button" data-edit-cancel>Cancel</button> <button class="primary" type="submit">Save</button></span></div></form>`);
      msg.querySelector('.edit-form textarea').focus();
      return;
    }
    const cancel = ev.target.closest('.edit-form button[data-edit-cancel]');
    if (cancel) { closeEditor(cancel.closest('form')); return; }
    const del = ev.target.closest('button[data-withdraw]');
    if (!del) return;
    ev.preventDefault();
    if (!(await B.confirm('Delete this message? Claude will skip it.'))) return;
    const id = del.dataset.withdraw;
    const { key, msg } = await pendingMessage(del, id);
    state.withdrawnAsks.add(id);
    B.render();
    if (msg) msg.hidden = true;
    try {
      await B.site.send('ask-withdrawn', { id, ...(key ? { key } : {}) });
      await hide(id, true);
      toast('Deleted', 2500);
      if (key) B.loadThread(key, { force: true }); else B.loadBoard();
    } catch { state.withdrawnAsks.delete(id); B.render(); if (msg) msg.hidden = false; toast('Could not delete', 3000); }
  });
  B.on(B.root, 'submit', async (ev) => {
    const form = ev.target.closest('form.edit-form');
    if (!form) return;
    ev.preventDefault();
    const text = form.querySelector('textarea').value.trim();
    if (!text) { toast('Write something, or delete the message', 3000); return; }
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      await B.site.send('ask-edited', { ...JSON.parse(form.dataset.event), text });
      const thread = form.dataset.threadKey;
      closeEditor(form);
      toast('Edited', 2500);
      if (thread) B.loadThread(thread, { force: true });
      B.loadBoard();
    } catch { btn.disabled = false; toast('Could not save', 3000); }
  });
  // The asks watch polls every 10 s while an ask waits for its reply, sooner than the board's own refresh.
  let asksSeen = false;
  B.watch((list) => {
    if (!list) return;
    if (asksSeen) B.loadBoard();
    asksSeen = true;
  }, { kind: 'ask', limit: 50 });
});
