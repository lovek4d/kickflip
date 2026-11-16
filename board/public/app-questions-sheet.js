// The questions sheet (docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md,
// docs/adr/2026-11-15-1200-waiting-on-you-is-one-list-of-rows-opening-the-questions-sheet.md): every way into a topic's
// questions opens this one sheet with that topic's open questions, a card's or a page's, drawn by questionCard
// (ui-questions.js) with each question's eye, fire, image and attach, and answered with Send. A prototype question shows
// its options and its View prototypes link. The questions group by the batch that asked them, the newest batch first,
// where the thread is at hand; one batch shows no heading. It is the reader sheet's shape (app-reader.js): modal below
// 900px, over the pane and not modal from it, closed by its ✕, Escape, the dim area, a swipe down and Back.
// docs/adr/2026-11-16-0500-each-answered-question-shows-at-once-as-sending.md: Send puts each answered question in the
// answer outbox on its own and sends them one at a time, each its own owner-answers. Each reads "<time> · sending…" in
// its footer at once while the others stay open and answerable, then Sent. once the board has it, or "not sent" with
// Retry and X, X opening it again with its pick and note. The sheet keeps the questions it opened with, sent ones
// included, and closes once the board has every question of its topic answered, leaving the page where it was.
// BoardQuestionsSheet(dialog, deps) makes one: the board's (the part below), opened by a thread's "N questions added"
// line, a question link (shell.js, app-pane.js) and a row in the desktop pane's Waiting on you; and the phone's Waiting
// on you page's own (view-questions.js), opened by its rows and a link to a question.
// deps: board() the board shown; threads(key) a card's thread held, or none; send(kind, data) the board's send, which
// has landed the board it answers by the time it resolves; toast(text); siteRoot, where its attachments upload; store,
// the board's own keys, which hold the answer outbox; changed(entry, sent) after an answer outbox entry changes, sent
// once the board has it; on, atUnmount and alive, the view's own.
// The answer outbox entries in flight from any sheet in this page, by sendId, so the board's and Waiting on you's, both
// mounted on a phone, never send one twice at once.
const answersInFlight = new Set();
globalThis.BoardQuestionsSheet = (sheet, { board, threads = () => [], send, toast, on, atUnmount, alive, store, changed = () => {}, siteRoot }) => {
  const { esc, time, questionCard, getDraft, setDraft, noteOf, choiceOf, linkContext, ANSWER_OUTBOX } = BoardUI;
  const body = sheet.querySelector('.reader-body');
  let topic = null;
  // The questions the sheet opened with, which it keeps drawing once sent.
  let kept = new Set();
  let modal = true;
  let pushed = false;

  const keyOf = (id) => (id?.startsWith('item:') ? id.slice(5) : null);
  // The topic a question or topic id names on the board shown, else null.
  const topicOf = (id) => board()?.owner.find((q) => q.id === id)?.topic ?? (board()?.ownerTopics.some((t) => t.id === id) ? id : null);
  const openOf = () => board().owner.filter((q) => q.topic === topic && q.state === 'open');
  const shownOf = () => board().owner.filter((q) => q.topic === topic && (q.state === 'open' || kept.has(q.id)));
  // The topic's batches, newest first: each its questions-added line's questions; one a line doesn't name comes last.
  function batches() {
    const shown = shownOf();
    const lines = (threads(keyOf(topic)) || []).filter((m) => m.line === 'questions-added').reverse();
    const groups = lines.map((m) => ({ line: m, qs: shown.filter((q) => m.questions.includes(q.id)) }));
    const rest = shown.filter((q) => !groups.some((g) => g.qs.includes(q)));
    return [...groups.filter((g) => g.qs.length), ...(rest.length ? [{ line: null, qs: rest }] : [])];
  }

  // The answer outbox, in send order: each {sendId, id, topic, key?, ts, answer, text, failed?}, answer the owner-answers
  // answer it sends and text its line in the card's thread, in the board's words (domain.mjs threadOf).
  const queued = () => store.get(ANSWER_OUTBOX, []);
  const setQueued = (list) => { store.set(ANSWER_OUTBOX, list); BoardUI.outboxChanged(); };
  const entryOf = (id) => queued().find((m) => m.id === id);

  const filesOf = (q) => BoardAttach.files('q:' + q.id, siteRoot);
  const uploading = () => openOf().some((q) => BoardAttach.busy('q:' + q.id, siteRoot));
  const pending = () => BoardUI.pendingAnswers(openOf().filter((q) => !entryOf(q.id)), filesOf);
  const numberOf = (q) => (board().ownerTopics.find((t) => t.id === q.topic)?.questions.indexOf(q.id) ?? -1) + 1;
  const status = (text) => { const st = sheet.querySelector('#qstatus'); if (st) st.textContent = text; };
  const refusal = (e) => (e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?');
  const card = (q, links) => questionCard(q, { n: numberOf(q), draft: getDraft(q.id), links, sending: q.state === 'open' ? entryOf(q.id) : null });

  function draw() {
    const d = board();
    const key = keyOf(topic);
    const it = key && d.items.find((i) => i.key === key);
    sheet.querySelector('.reader-ref').textContent = it ? `${it.ref} · ${it.title}` : d.ownerTopics.find((t) => t.id === topic)?.title || '';
    const links = linkContext(d.items, key, { base: './' });
    const groups = batches();
    body.innerHTML = `<div class="view-questions qs-body"><form data-qsform>
      ${groups.map((g) => `${groups.length > 1 && g.line ? `<h3 class="qs-round">${esc(g.line.text)} <span class="muted">· ${esc(time(g.line.ts))}</span></h3>` : ''}${g.qs.map((q) => card(q, links)).join('')}`).join('')}
      <div class="bar"><span class="muted small" id="qstatus" role="status"></span>${BoardUI.sendButton('Send', 0, ' id="send"')}</div>
    </form></div>`;
    BoardAttach.paintAll();
    updateBar();
  }
  // One question's card drawn again in place, so a box being typed in elsewhere in the sheet keeps its focus.
  function drawOne(id) {
    const sec = body.querySelector(`section.q[data-q="${CSS.escape(id)}"]`);
    const q = board().owner.find((x) => x.id === id);
    if (!sec || !q) return;
    sec.outerHTML = card(q, linkContext(board().items, keyOf(topic), { base: './' }));
    BoardAttach.paintAll();
    updateBar();
  }
  function updateBar() {
    const button = sheet.querySelector('#send');
    if (!button) return;
    button.disabled = !pending().length || uploading();
    button.childNodes[0].textContent = uploading() ? 'Uploading…' : 'Send';
  }
  // After a recorded tap: the sheet draws the board it landed, or closes once the topic has no open question.
  const redraw = () => { if (!sheet.open) return; if (openOf().length) draw(); else close(); };
  // After question id's answer changed in the outbox: its card draws again, or the sheet closes once the board has every
  // question of the topic answered.
  const settle = (id) => { if (!sheet.open) return; if (openOf().length) drawOne(id); else close(); };

  // id: a question's or a topic's. → false for one the board doesn't have, or a topic with no open question.
  function open(id) {
    const t = topicOf(id);
    if (!t) return false;
    const was = topic;
    topic = t;
    if (!openOf().length) { topic = was; return false; }
    if (t !== was || !sheet.open) kept = new Set(openOf().map((q) => q.id));
    if (!sheet.open) {
      modal = !matchMedia('(min-width: 900px)').matches;
      if (modal) sheet.showModal(); else sheet.show();
      history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1, questions: true }, '', location.href);
      pushed = true;
    }
    draw();
    return true;
  }
  function close() {
    if (!sheet.open) return;
    sheet.close();
    topic = null;
    if (pushed) { pushed = false; history.back(); }
  }

  // Sends the answer outbox in order, one at a time. Each leaves it once the board has it, its draft and files cleared;
  // one the board can't be reached for stays as not sent, holding none behind it; one the board refuses leaves it, its
  // question open again with its pick and note, and a toast says why.
  let flushing = false;
  const next = () => queued().find((m) => !m.failed && !answersInFlight.has(m.sendId));
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (let m = next(); m && alive(); m = next()) {
        answersInFlight.add(m.sendId);
        let failure = null;
        try { await send('owner-answers', { answers: [m.answer] }); } catch (e) { failure = e; } finally { answersInFlight.delete(m.sendId); }
        if (!alive()) return;
        if (!failure) {
          setQueued(queued().filter((o) => o.sendId !== m.sendId));
          setDraft(m.id, {});
          BoardAttach.clear('q:' + m.id, siteRoot);
        } else if (failure.status === 400) {
          setQueued(queued().filter((o) => o.sendId !== m.sendId));
          toast(refusal(failure));
        } else setQueued(queued().map((o) => (o.sendId === m.sendId ? { ...o, failed: true } : o)));
        changed(m, !failure);
        settle(m.id);
      }
    } finally { flushing = false; }
  }
  // Whatever a reload left in the answer outbox goes out again, a failed one included, once the board first lands.
  function resend() {
    if (queued().some((m) => m.failed)) setQueued(queued().map(({ failed, ...m }) => m));
    for (const m of queued()) changed(m, false);
    flush();
  }
  // Retry sends a failed answer again in place; X drops it, its question open again with its pick and note.
  function retry(sendId) {
    const m = queued().find((o) => o.sendId === sendId);
    if (!m) return;
    setQueued(queued().map((o) => (o.sendId === sendId ? { ...o, failed: false } : o)));
    changed(m, false);
    settle(m.id);
    flush();
  }
  function drop(sendId) {
    const m = queued().find((o) => o.sendId === sendId);
    if (!m) return;
    setQueued(queued().filter((o) => o.sendId !== sendId));
    changed(m, false);
    settle(m.id);
  }
  const holds = (sendId) => queued().some((m) => m.sendId === sendId);

  on(sheet, 'submit', (ev) => {
    ev.preventDefault();
    const list = pending();
    if (uploading()) return;
    if (!list.length) { status('Pick an option or write a note first.'); return; }
    status('');
    const ts = new Date().toISOString();
    const entries = list.map((q) => {
      const sendId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const answer = { ...BoardUI.answerOf(q, filesOf(q)), sendId };
      const key = keyOf(q.topic);
      return { sendId, id: q.id, topic: q.topic, ...(key ? { key } : {}), ts, answer,
        text: `Question ${numberOf(q)} · ${q.question}\n→ ${[answer.label || answer.choice, answer.note].filter(Boolean).join(' · ')}` };
    });
    setQueued([...queued(), ...entries]);
    for (const m of entries) { changed(m, false); drawOne(m.id); }
    flush();
  });

  // docs/adr/2026-11-02-1822-each-question-has-its-own-prototype-eye.md, docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md
  // A question's eye, fire or image sends `prototype-request`, `grill-more` or `visual-request {key?, question, note,
  // choice}` for that question, its note box the note and its pick so far the choice. The prototype's question then
  // reads prototype requested, locked, and leaves the sheet; the grill's reads Grilling deeper; the visual's stays open.
  const REQUEST = { prototype: ['prototype-request', 'Prototype requested.'], grill: ['grill-more', 'Grill requested.'], visual: ['visual-request', 'Visual requested.'] };
  async function ask(q, flag, button) {
    const [kind, said] = REQUEST[flag];
    const key = keyOf(q.topic);
    const d = getDraft(q.id);
    status('');
    try { await BoardUI.waitOn(button, send(kind, { ...(key ? { key } : {}), question: q.id, note: noteOf(q, d).trim(), choice: choiceOf(q, d) })); } catch (e) { status(refusal(e)); return; }
    if (flag === 'prototype') { setDraft(q.id, {}); kept.delete(q.id); }
    toast(said);
    redraw();
  }

  BoardUI.wireAnswerForm(on, sheet, updateBar);
  on(sheet, 'attach-change', updateBar);
  on(sheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, sheet) || ev.target.closest?.('[data-qs="close"]')) { close(); return; }
    const again = ev.target.closest?.('section.q [data-resend], section.q [data-unsend]');
    if (again) { if (again.hasAttribute('data-resend')) retry(again.dataset.resend); else drop(again.dataset.unsend); return; }
    const request = ev.target.closest?.('section.q [data-proto], section.q [data-grill], section.q [data-visual]');
    if (!request || request.disabled) return;
    const q = board().owner.find((x) => x.id === request.closest('section.q').dataset.q);
    if (q) ask(q, BoardUI.requestOf(request), request);
  });
  // A non-modal sheet (from 900px) gets no cancel event from Escape, so the page's own key closes it.
  on(document, 'keydown', (ev) => { if (ev.key === 'Escape' && sheet.open && !modal) close(); });
  atUnmount(BoardUI.swipeToDismiss(sheet));
  on(sheet, 'cancel', (ev) => { ev.preventDefault(); close(); });
  // Back while it's open: the router keeps the view, as the entry under it holds the same URL.
  on(window, 'popstate', () => { if (pushed) { pushed = false; sheet.close(); topic = null; } });

  return { open, close, redraw, resend, retry, drop, holds, isOpen: () => sheet.open };
};

// The board's sheet, over the lanes and the pane. Needs app-core.js and app-threads.js, whose card threads draw the
// answer outbox's lines (B.answerChanged).
BoardView.part((B) => {
  const { $, state } = B;
  const qs = BoardQuestionsSheet($('#questionsSheet'), {
    board: () => state.board, threads: (key) => state.threadCache.get(key), send: (kind, data) => B.send(kind, data), toast: (text) => B.toast(text),
    on: B.on, atUnmount: B.atUnmount, alive: B.alive, store: B.store, changed: (m, sent) => B.answerChanged(m, sent), siteRoot: B.site.root,
  });
  // The thread line's tap opens it from the line's first question.
  B.on(B.root, 'click', (ev) => {
    const a = ev.target.closest?.('a[data-questions]');
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (qs.open(a.dataset.questions)) ev.preventDefault();
  });
  Object.assign(B, { openQuestionsSheet: qs.open, closeQuestionsSheet: qs.close, resendAnswers: qs.resend, retryAnswer: qs.retry, dropAnswer: qs.drop, holdsAnswer: qs.holds });
});
