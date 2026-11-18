// The + button and the sheet that sends a new task as an ask event, on the board's main page and the hub page alone: each view's markup
// puts BoardNewTask.markup() in its root and wires it with BoardNewTask.wire(B). No other page opts in. The send is B.enqueue:
// on a board the outbox (app-threads.js enqueue), shown at once in the New strip; on the hub page a post to the router (view-hub.js). B.newTaskKey(ev) is the n-twice handler, which a framed page's document also feeds.
globalThis.BoardNewTask = (function () {
  const markup = () => `<button id="compose" class="fab" type="button" aria-label="New task" title="New task (press n twice)" aria-haspopup="dialog" aria-expanded="false"><svg width="35" height="35" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
<dialog id="sheet" class="sheet" aria-labelledby="sheetTitle">
  <form id="askForm" data-composer="ask">
    <div class="sheet-head"><h2 id="sheetTitle">New task</h2><button type="button" class="ghost" id="sheetClose" aria-label="Close">✕</button></div>
    ${BoardUI.dropZone('<textarea id="askText" rows="4" placeholder="Ask a question or give me a task…" autofocus></textarea>')}
    <div class="note-tools"><div class="pending-files" data-files></div>${BoardUI.requestRow('ask')}</div>
    <div class="send-actions">${BoardUI.sendButton('Implement', 1, ' data-intent="quick"')}${BoardUI.sendButton('Discuss', 0, ' data-intent="discuss"')}</div>
  </form>
</dialog>`;

  function wire(B) {
    const { $, store, quieted, sendDraft } = B;
    const { keyedSend } = BoardUI;
    // The ask box is a bottom sheet: a <dialog> opened from the + button. Closing keeps the draft.
    const sheet = $('#sheet');
    // Files picked before the app shell switched away from this board are still attached, so they show again.
    BoardAttach.paint('ask', B.site.root);
    // ⌘↵ sends the ask as Discuss and ⌥↵ as Implement (ui.js keyedSend).
    B.on($('#askText'), 'keydown', (ev) => {
      const request = BoardUI.keyedRequest(ev, $('#askForm'));
      if (request) { ev.preventDefault(); request.click(); return; }
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
      BoardUI.openSheet(sheet);
      $('#askText').focus({ preventScroll: true });
      $('#compose').setAttribute('aria-expanded', 'true');
    }
    function closeSheet() {
      if (!sheet.open || sheet.classList.contains('closing')) return;
      $('#compose').setAttribute('aria-expanded', 'false');
      BoardUI.closeSheet(sheet, B.later);
    }
    B.on($('#compose'), 'click', openSheet);
    // n pressed twice opens the sheet, as the + button's tooltip says, unless a field has focus or the sheet is already open. With
    // nothing focused the key goes to <body>, outside the view, so this listens on the document, and a framed page's
    // own document is given to the same handler (view-frame.js). A key switch mode used (sidebar.js) comes
    // defaultPrevented and doesn't count.
    const TWICE_MS = 500;
    let lastN = -Infinity;
    const newTaskKey = (ev) => {
      if (ev.defaultPrevented) { lastN = -Infinity; return; }
      if (ev.key !== 'n' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || ev.isComposing) return;
      const field = ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (field || sheet.open || B.root.classList.contains('down')) { lastN = -Infinity; return; }
      if (ev.timeStamp - lastN > TWICE_MS) { lastN = ev.timeStamp; return; }
      lastN = -Infinity;
      ev.preventDefault();
      openSheet();
    };
    B.newTaskKey = newTaskKey;
    B.on(document, 'keydown', newTaskKey);
    B.on($('#sheetClose'), 'click', closeSheet);
    B.on(sheet, 'click', (ev) => { if (BoardUI.onBackdrop(ev, sheet) && BoardUI.outsideBox(ev, sheet)) closeSheet(); });
    B.atUnmount(BoardUI.swipeToDismiss(sheet));
    B.on(sheet, 'cancel', (ev) => { ev.preventDefault(); closeSheet(); });
    // Discuss has the session reply to the task, starting its discussion; Implement sends the ask with quick: true, and
    // the session marks the card ready (docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md).
    // docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md: a send closes the box at once
    // and the task goes through the outbox (app-threads.js enqueue), its New strip row reading sending… until the board
    // has it. docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md: the box's files go
    // with the task, uploads still running, and it is sent once every one is up; its row shows them meanwhile.
    // docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md: the Prototype, Grill and Visual under the box send
    // the task at once with request prototype, grill or visual, as /prototype, /grill or /visual in its text does on
    // either button; a request takes the place of Implement's quick, as a thread's request takes the place of its intent.
    async function sendAsk(button, flag = null) {
      $('#askText').blur();
      const slash = BoardUI.slashOf($('#askText').value);
      const request = flag || slash.flag;
      const text = request ? slash.text : $('#askText').value.trim();
      const quick = !request && button?.dataset.intent === 'quick';
      const attached = BoardAttach.list('ask', B.site.root).length > 0;
      if (!text && !attached) return;
      const fields = request ? { request } : quick ? { quick: true } : null;
      await sendDraft('draft:ask', $('#askText'), () => $('#askText'), async () => B.enqueue(undefined, { kind: 'ask', text, ...(attached ? { attached: 'ask' } : {}), ...(fields ? { fields } : {}) }));
      closeSheet();
    }
    B.on($('#askForm'), 'submit', (ev) => {
      ev.preventDefault();
      sendAsk(ev.submitter);
    });
    B.on(B.root, 'click', (ev) => {
      const b = ev.target.closest('#askForm button[data-proto], #askForm button[data-grill], #askForm button[data-visual]');
      if (b) sendAsk(null, BoardUI.requestOf(b));
    });
    // X on a New task the board didn't take (app-threads.js) puts its text back in the box, before whatever is typed
    // there, and its files with it, those still in its own box as they are, a failed one still marked, and opens the box.
    B.reopenAsk = (m) => {
      const text = [m.text, $('#askText').value].filter(Boolean).join('\n\n');
      $('#askText').value = text;
      store.set('draft:ask', text);
      if (m.uploads) BoardAttach.move(B.sendBox(m), 'ask', B.site.root);
      else BoardAttach.restore('ask', m.files, B.site.root);
      openSheet();
    };
  }

  return { markup, wire };
})();
