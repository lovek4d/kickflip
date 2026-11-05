// The + button and the sheet that sends a new task as an ask event, on every page of a board: the board view's markup
// (app.js) and each other view of a board (shell.js) put BoardNewTask.markup() in their root and wire it with
// BoardNewTask.wire(B) once mounted. A board's view sends through B.send, which lands the board the ask changed; any
// other view sends through its site. B.newTaskKey(ev) is the n-twice handler, which a framed page's document also feeds.
globalThis.BoardNewTask = (function () {
  const markup = () => `<button id="compose" class="fab" type="button" aria-label="New task" title="New task (press n twice)" aria-haspopup="dialog" aria-expanded="false"><svg width="35" height="35" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
<dialog id="sheet" class="sheet" aria-labelledby="sheetTitle">
  <form id="askForm" data-composer="ask">
    <div class="sheet-head"><h2 id="sheetTitle">New task</h2><button type="button" class="ghost" id="sheetClose" aria-label="Close">✕</button></div>
    ${BoardUI.dropZone('<textarea id="askText" rows="4" placeholder="Ask a question or give me a task…" autofocus></textarea>')}
    <div class="pending-files" data-files></div>
    <div class="send-actions">${BoardUI.sendButton('Quick build', 1, ' data-intent="quick"')}${BoardUI.sendButton('Discuss', 0, ' data-intent="discuss"')}</div>
    <p class="muted small" id="askStatus" aria-live="polite"></p>
  </form>
</dialog>`;

  function wire(B) {
    // A shared person looks only (shell.js marks the page shared-view, and style.css hides the +), so n twice opens nothing.
    if (document.documentElement.classList.contains('shared-view')) return;
    const { $, store, toast, quieted, sendDraft } = B;
    const { waitOn, keyedSend } = BoardUI;
    const send = (kind, data) => (B.send ? B.send(kind, data) : B.site.send(kind, data));
    // The ask box is a bottom sheet: a <dialog> opened from the + button. Closing keeps the draft.
    const sheet = $('#sheet');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    // Files picked before the app shell switched away from this board are still attached, so they show again.
    BoardAttach.paint('ask', B.site.root);
    // ⌘↵ sends the ask as Discuss and ⌥↵ as Quick build (ui.js keyedSend).
    B.on($('#askText'), 'keydown', (ev) => {
      const button = keyedSend(ev, $('#askForm'));
      if (!button) return;
      ev.preventDefault();
      $('#askForm').requestSubmit(button);
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
    // nothing focused the key goes to <body>, outside the view, so this listens on the document, and a framed page's
    // own document is given to the same handler (view-frame.js). A key switch mode used (sidebar.js) comes
    // defaultPrevented and doesn't count.
    const TWICE_MS = 500;
    let lastN = -Infinity;
    const newTaskKey = (ev) => {
      if (ev.defaultPrevented) { lastN = -Infinity; return; }
      if (ev.key !== 'n' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || ev.isComposing) return;
      const field = ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (field || document.querySelector('dialog[open]') || B.root.classList.contains('offline')) { lastN = -Infinity; return; }
      if (ev.timeStamp - lastN > TWICE_MS) { lastN = ev.timeStamp; return; }
      lastN = -Infinity;
      ev.preventDefault();
      openSheet();
    };
    B.newTaskKey = newTaskKey;
    B.on(document, 'keydown', newTaskKey);
    B.on($('#sheetClose'), 'click', closeSheet);
    B.on(sheet, 'click', (ev) => { if (ev.target === sheet) closeSheet(); });
    B.on(sheet, 'cancel', (ev) => { ev.preventDefault(); closeSheet(); });
    // Discuss has the session grill or prototype the task at once; Quick build sends the ask with quick: true, and the
    // session marks the card ready (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
    B.on($('#askForm'), 'submit', async (ev) => {
      ev.preventDefault();
      $('#askText').blur();
      const text = $('#askText').value.trim();
      const files = BoardAttach.files('ask', B.site.root);
      const button = ev.submitter;
      const quick = button.dataset.intent === 'quick';
      if ((!text && !files.length) || BoardAttach.busy('ask', B.site.root)) return;
      $('#askStatus').textContent = '';
      try {
        await waitOn(button, sendDraft('draft:ask', $('#askText'), () => $('#askText'), () => send('ask', { text, ...(files.length ? { files } : {}), ...(quick ? { quick: true } : {}) })));
        BoardAttach.clear('ask', B.site.root);
        $('#askStatus').textContent = '';
        closeSheet();
        toast('Sent');
      } catch { $('#askStatus').textContent = 'Could not send'; }
    });
  }

  return { markup, wire };
})();
