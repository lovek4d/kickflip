// The questions sheet (docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md): a thread's
// "N questions added" line opens a sheet over the board with only that card's open questions, drawn by the Waiting on
// you page's own questionCard (ui-questions.js) and answered with the same Send (owner-answers). The questions group by
// the batch that asked them, the newest batch first; a card with one batch shows no heading. Send closes the sheet and
// leaves the page where it was, so a phone stays on the board. It is the reader sheet's shape (app-reader.js): modal
// below 900px, over the pane and not modal from it, closed by its ✕, Escape, the dim area, a swipe down and Back.
// A question link (shell.js, view-questions.js) opens it through B.openQuestionsSheet, in place of the questions page.
// Needs app-core.js and app-pane.js.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc, time, questionCard, getDraft, linkContext } = BoardUI;
  const sheet = $('#questionsSheet');
  const body = sheet.querySelector('.reader-body');
  let key = null;
  let modal = true;
  let pushed = false;

  // The card a question is asked on, when its topic is the card's, else null.
  const cardOf = (qid) => {
    const q = state.board?.owner.find((x) => x.id === qid);
    return q?.topic?.startsWith('item:') ? q.topic.slice(5) : null;
  };
  // A question on a prototype page is answered in the prototype viewer from the questions page, so the sheet leaves it out.
  const openOf = () => state.board.owner.filter((q) => q.topic === `item:${key}` && q.state === 'open' && !BoardUI.isPrototype(q.url));
  // The card's batches, newest first: each its questions-added line's open questions; one a line doesn't name comes last.
  function batches() {
    const open = openOf();
    const lines = (state.threadCache.get(key) || []).filter((m) => m.line === 'questions-added').reverse();
    const groups = lines.map((m) => ({ line: m, qs: open.filter((q) => m.questions.includes(q.id)) }));
    const rest = open.filter((q) => !groups.some((g) => g.qs.includes(q)));
    return [...groups.filter((g) => g.qs.length), ...(rest.length ? [{ line: null, qs: rest }] : [])];
  }
  const filesOf = (q) => BoardAttach.files('q:' + q.id, B.site.root);
  const uploading = () => openOf().some((q) => BoardAttach.busy('q:' + q.id, B.site.root));
  const pending = () => BoardUI.pendingAnswers(openOf(), filesOf);
  const numberOf = (q) => (state.board.ownerTopics.find((t) => t.id === q.topic)?.questions.indexOf(q.id) ?? -1) + 1;

  function draw() {
    const it = state.board.items.find((i) => i.key === key);
    sheet.querySelector('.reader-ref').textContent = it ? `${it.ref} · ${it.title}` : '';
    const links = linkContext(state.board.items, key, { base: './' });
    const groups = batches();
    body.innerHTML = `<div class="view-questions qs-body"><form data-qsform>
      ${groups.map((g) => `${groups.length > 1 && g.line ? `<h3 class="qs-round">${esc(g.line.text)} <span class="muted">· ${esc(time(g.line.ts))}</span></h3>` : ''}${g.qs.map((q) => questionCard(q, { n: numberOf(q), draft: getDraft(q.id), links, eye: false })).join('')}`).join('')}
      <div class="bar"><span class="muted small" id="qstatus" role="status"></span>${BoardUI.sendButton('Send', 0, ' id="send"')}</div>
    </form></div>`;
    BoardAttach.paintAll();
    updateBar();
  }
  function updateBar() {
    const send = sheet.querySelector('#send');
    if (!send) return;
    send.disabled = !pending().length || uploading();
    send.childNodes[0].textContent = uploading() ? 'Uploading…' : 'Send';
  }

  // → false for a question that isn't on a card the board shows, or has none open.
  function open(qid) {
    const card = cardOf(qid);
    if (!card || !state.board.items.some((i) => i.key === card)) return false;
    key = card;
    if (!openOf().length) { key = null; return false; }
    if (!sheet.open) {
      modal = !matchMedia('(min-width: 900px)').matches;
      if (modal) sheet.showModal(); else sheet.show();
      history.pushState({ ...history.state, idx: history.state.idx + 1, questions: true }, '', location.href);
      pushed = true;
    }
    draw();
    return true;
  }
  function close() {
    if (!sheet.open) return;
    sheet.close();
    key = null;
    if (pushed) { pushed = false; history.back(); }
  }

  B.on(sheet, 'submit', async (ev) => {
    ev.preventDefault();
    const list = pending();
    const status = sheet.querySelector('#qstatus');
    if (uploading()) return;
    if (!list.length) { status.textContent = 'Pick an option or write a note first.'; return; }
    status.textContent = '';
    const answers = list.map((q) => BoardUI.answerOf(q, filesOf(q)));
    try { await BoardUI.waitOn(sheet.querySelector('#send'), B.send('owner-answers', { answers })); } catch (e) {
      status.textContent = e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?';
      return;
    }
    for (const q of list) {
      BoardUI.setDraft(q.id, {});
      BoardAttach.clear('q:' + q.id, B.site.root);
    }
    B.toast(`Sent ${list.length} answer${list.length === 1 ? '' : 's'}.`);
    close();
  });
  BoardUI.wireAnswerForm(B.on, sheet, updateBar);
  B.on(sheet, 'attach-change', updateBar);
  B.on(sheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, sheet) || ev.target.closest('[data-qs="close"]')) close();
  });
  // The thread line's tap opens it from the line's first question.
  B.on(B.root, 'click', (ev) => {
    const a = ev.target.closest?.('a[data-questions]');
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (open(a.dataset.questions)) ev.preventDefault();
  });
  // A non-modal sheet (from 900px) gets no cancel event from Escape, so the page's own key closes it.
  B.on(document, 'keydown', (ev) => { if (ev.key === 'Escape' && sheet.open && !modal) close(); });
  B.atUnmount(BoardUI.swipeToDismiss(sheet));
  B.on(sheet, 'cancel', (ev) => { ev.preventDefault(); close(); });
  // Back while it's open: the router has kept the board, as the entry under it holds the same URL.
  B.on(window, 'popstate', () => { if (pushed) { pushed = false; sheet.close(); key = null; } });

  Object.assign(B, { openQuestionsSheet: open, closeQuestionsSheet: close });
});
