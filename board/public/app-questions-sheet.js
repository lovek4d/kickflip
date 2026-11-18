// The questions sheet (docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md,
// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md): every way into a topic's
// questions opens this one sheet with that topic's open questions, a card's or a topic of no card's, drawn by questionCard
// (ui-questions.js) with each question's Prototype, Grill, Visual and attach, and answered with Send. A prototype question shows
// its options and its View prototypes link. The questions group by the batch that asked them, the newest batch first,
// where the thread is at hand; one batch shows no heading. It is the reader sheet's shape (app-reader.js): modal below
// 900px, over the pane and not modal from it, closed by its ✕, Escape, the dim area and a swipe down. It makes no history entry
// of its own; opened over another sheet it stacks on it with one (ui.js openSheet).
// docs/adr/2026-11-16-2100-a-question-sets-answers-send-as-one.md: Send puts the answered questions in the answer
// outbox as one set, sends it as one owner-answers and closes the sheet at once; the unanswered questions stay open
// with their picks and notes. The set reads as one message in the card's thread, "sending…" at once, or "not sent" with
// Retry and X, X dropping the set, its questions open again with their picks and notes. Opened again meanwhile, the
// sheet draws each question of the set read-only, "<time> · sending…" or not sent in its footer, then Sent. The sheet
// keeps the questions it opened with, sent ones included, and closes once the board has every question of its topic
// answered, leaving the page where it was.
// BoardQuestionsSheet(dialog, deps) makes one: the board's (the part below), opened by a thread's "N questions added"
// line, a card's Questions and a question link (shell.js, app-pane.js).
// deps: board() the board shown; threads(key) a card's thread held, or none; send(kind, data, signal) the board's send, which
// has landed the board it answers by the time it resolves; online() whether the board is in reach, and unreachable()
// to call when a send got no answer at all
// (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md); toast(text); siteRoot, where its attachments upload; store,
// the board's own keys, which hold the answer outbox; changed(entry, sent) after an answer outbox entry changes, sent
// once the board has it; on, atUnmount and alive, the view's own.
// The answer outbox entries in flight, by sendId, so none is sent twice at once.
const answersInFlight = new Set();
globalThis.BoardQuestionsSheet = (sheet, { board, threads = () => [], send, online, unreachable, toast, on, atUnmount, alive, store, changed = () => {}, siteRoot }) => {
  const { esc, time, questionCard, getDraft, setDraft, noteOf, choiceOf, linkContext, ANSWER_OUTBOX, idsOf, answerBox } = BoardUI;
  const body = sheet.querySelector('.reader-body');
  let topic = null;
  // The view's timer: a close still playing when the view goes is dropped with it.
  const later = (ms, fn) => { const t = setTimeout(fn, ms); atUnmount(() => clearTimeout(t)); };
  // The questions the sheet opened with, which it keeps drawing once sent.
  let kept = new Set();
  let modal = true;
  // Whether the open sheet follows the opened card (autoOpen), as opposed to one the owner opened by hand.
  let autoOpen = false;

  const keyOf = (id) => (id?.startsWith('item:') ? id.slice(5) : null);
  // The topic a question or topic id names on the board shown, else null.
  const topicOf = (id) => board()?.owner.find((q) => q.id === id)?.topic ?? (board()?.ownerTopics.some((t) => t.id === id) ? id : null);
  const openOf = () => board().owner.filter((q) => q.topic === topic && q.state === 'open');
  const shownOf = () => board().owner.filter((q) => q.topic === topic && (q.state === 'open' || kept.has(q.id)));
  // The topic's batches, newest first: each its questions-added line's questions; one no line names comes last, as
  // those do of a line a thread kept from before the lines named their questions.
  function batches() {
    const shown = shownOf();
    const lines = (threads(keyOf(topic)) || []).filter((m) => m.line === 'questions-added' && m.questions).reverse();
    const groups = lines.map((m) => ({ line: m, qs: shown.filter((q) => m.questions.includes(q.id)) }));
    const rest = shown.filter((q) => !groups.some((g) => g.qs.includes(q)));
    return [...groups.filter((g) => g.qs.length), ...(rest.length ? [{ line: null, qs: rest }] : [])];
  }

  // The answer outbox, in send order: each answer set {sendId, topic, key?, ts, answers, text, uploads?, failed?},
  // answers the owner-answers answers it sends, each carrying the set's sendId, and text its one line in the card's
  // thread, in the board's words (domain.mjs threadOf, foldSubmits). A question's prototype, grill or visual request
  // goes through it too, as {sendId, id, topic, key?, ts, request: {kind, said, data}, failed?}: it sends its kind with
  // data and its footer reads said.
  const queued = () => store.get(ANSWER_OUTBOX, []);
  const setQueued = (list) => { store.set(ANSWER_OUTBOX, list); BoardUI.outboxChanged(); };
  const entryOf = (id) => queued().find((m) => idsOf(m).includes(id));

  // A question's attached files, up or not: a set takes each answer's into that answer's own box (answerBox), kept
  // for a reload in its uploads by question id, and sends once every one is up.
  const attachedOf = (q) => BoardAttach.list('q:' + q.id, siteRoot);
  const boxOf = (m, id) => answerBox(m.sendId, id);
  const boxesOf = (m) => Object.keys(m.uploads || {});
  const pending = () => BoardUI.pendingAnswers(openOf().filter((q) => !entryOf(q.id)), attachedOf);
  const numberOf = (q) => (board().ownerTopics.find((t) => t.id === q.topic)?.questions.indexOf(q.id) ?? -1) + 1;
  const status = (text) => { sheet.querySelector('#qstatus').textContent = text; };
  // While open, the sheet follows the phone's keyboard (dialogs.js fitSheet): its --kb lifts the footer above it.
  let unfit = null;
  const unfitted = () => { unfit?.(); unfit = null; };
  const refusal = (e) => (e.reason ? `Nothing was sent: ${e.reason}` : 'Could not send. Is the host awake?');
  // A question's entry in the outbox as its card draws it: a set's with that question's answer and files.
  const sendingOf = (q) => {
    const m = q.state === 'open' ? entryOf(q.id) : null;
    if (!m) return null;
    const { uploads, answers, ...rest } = m;
    return { ...rest, held: !online(), ...(answers ? { answer: answers.find((a) => a.id === q.id) } : {}),
      ...(uploads?.[q.id] ? { uploads: { box: boxOf(m, q.id), list: BoardAttach.list(boxOf(m, q.id), siteRoot) } } : {}) };
  };
  const card = (q, links) => questionCard(q, { n: numberOf(q), draft: getDraft(q.id), links, sending: sendingOf(q) });

  function draw() {
    const d = board();
    const key = keyOf(topic);
    const it = key && d.items.find((i) => i.key === key);
    sheet.querySelector('.reader-ref').textContent = it ? `${it.ref} · ${it.title}` : d.ownerTopics.find((t) => t.id === topic)?.title || '';
    const links = linkContext(d.items, key, { base: './' });
    const groups = batches();
    body.innerHTML = `<div class="view-questions qs-body" data-request-words="${BoardUI.requestShown(it) ? 'shown' : 'hidden'}">
      ${groups.map((g) => `${groups.length > 1 && g.line ? `<h3 class="qs-round">${esc(g.line.text)} <span class="muted">· ${esc(time(g.line.ts))}</span></h3>` : ''}${g.qs.map((q) => card(q, links)).join('')}`).join('')}
    </div>`;
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
  // Send is on once a question is answered, and the status counts those answered of the questions still to send.
  function updateBar() {
    const answered = pending().length;
    const left = openOf().filter((q) => !entryOf(q.id)).length;
    sheet.querySelector('#send').disabled = !answered;
    status(left ? `${answered} of ${left} answered` : '');
  }
  // After a recorded tap: the sheet draws the board it landed, or closes once the topic has no open question.
  const redraw = () => { if (!sheet.open) return; if (openOf().length) draw(); else close(); };
  // After entry m changed in the outbox: each of its questions' cards draws again, or the sheet closes once the board has
  // every question of the topic answered.
  const settle = (m) => {
    for (const id of idsOf(m)) {
      if (!sheet.open) return;
      if (!openOf().length) { close(); return; }
      if (shownOf().some((q) => q.id === id)) drawOne(id); else draw();
    }
  };

  // id: a question's or a topic's. auto: the sheet follows the opened card (followCard); otherwise the owner opened it,
  // and followCard leaves it. A sheet already open for that topic stays as it is, except that a tap that isn't auto makes
  // it the owner's. → false for one the board doesn't have; for a topic with no open question, false when auto or when
  // none was ever answered, else the sheet opens on its latest batch, answered.
  function open(id, { auto = false } = {}) {
    const t = topicOf(id);
    if (!t) return false;
    if (shows(t) && openOf().length) {
      // The owner's open of a sheet under another, such as a question link in the reader, brings it back on top.
      if (!auto) { autoOpen = false; BoardUI.openSheet(sheet, { modal }); }
      return true;
    }
    const was = topic;
    topic = t;
    const live = openOf().length > 0;
    const answered = board().owner.filter((q) => q.topic === t && q.state !== 'open').map((q) => q.id);
    if (!live && (auto || !answered.length)) { topic = was; return false; }
    autoOpen = auto;
    BoardUI.cutClose(sheet);
    if (t !== was || !sheet.open) {
      // With nothing open, the sheet shows the topic's latest batch, answered.
      if (live) kept = new Set(openOf().map((q) => q.id));
      else { kept = new Set(answered); kept = new Set(batches()[0].qs.map((q) => q.id)); }
    }
    if (!sheet.open) { modal = !matchMedia('(min-width: 900px)').matches; unfit ||= BoardDialogs.fitSheet(sheet); }
    if (!sheet.open || !auto) BoardUI.openSheet(sheet, { modal });
    draw();
    return true;
  }
  // From 900px, a card the owner opens opens its questions sheet while none is open or the open one is autoOpen; a card
  // with no open questions closes an autoOpen sheet.
  function followCard(key) {
    if (!matchMedia('(min-width: 900px)').matches || (sheet.open && !autoOpen)) return;
    if (!open(`item:${key}`, { auto: true }) && sheet.open) close();
  }
  // Whether the sheet is open for that topic and not on its way out.
  const shows = (t) => sheet.open && !sheet.classList.contains('closing') && topic === t;
  // A card the owner collapses closes its questions sheet if it opened by itself.
  function leaveCard(key) {
    if (sheet.open && autoOpen && topic === `item:${key}`) close();
  }
  function close() {
    BoardUI.closeSheet(sheet, later, () => { topic = null; });
  }

  // Sends the answer outbox in order, one entry at a time, while the board is in reach. Each leaves it once the board has
  // it, its drafts and files cleared; one that got no answer at all marks the board out of reach and waits for it to come
  // back (linkChanged); one the board answers with an error, or that has no answer in 15 s (ui.js sendWithin), stays as
  // not sent, holding none behind it; one the board refuses leaves it, its question open again with its pick and note,
  // and a toast says why.
  let flushing = false;
  const next = () => queued().find((m) => !m.failed && !answersInFlight.has(m.sendId));
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (let m = next(); m && online() && alive(); m = next()) {
        answersInFlight.add(m.sendId);
        let failure = null;
        try {
          // A set with files waits for every one to be up and sends each answer with its own; an upload that failed sends
          // nothing.
          if (m.uploads) {
            const boxed = boxesOf(m);
            for (const id of boxed) if (!(await BoardAttach.settled(boxOf(m, id), siteRoot))) throw new Error('Upload failed');
            const { uploads, ...rest } = m;
            m = { ...rest, answers: m.answers.map((a) => (boxed.includes(a.id) ? { ...a, files: BoardAttach.files(boxOf(m, a.id), siteRoot) } : a)) };
            setQueued(queued().map((o) => (o.sendId === m.sendId ? m : o)));
            for (const id of boxed) BoardAttach.clear(boxOf(m, id), siteRoot);
          }
          await BoardUI.sendWithin((signal) => (m.request ? send(m.request.kind, m.request.data, signal) : send('owner-answers', { answers: m.answers }, signal)));
        } catch (e) { failure = e; } finally { answersInFlight.delete(m.sendId); }
        if (!alive()) return;
        if (failure?.unreachable) {
          unreachable();
          changed(m, false);
          settle(m);
          break;
        }
        if (!failure) {
          setQueued(queued().filter((o) => o.sendId !== m.sendId));
          // A sent prototype request takes its question out of the sheet; a grill's and a visual's keep their draft.
          if (m.request?.kind === 'prototype-request') kept.delete(m.id);
          if (!m.request || m.request.kind === 'prototype-request') for (const id of idsOf(m)) setDraft(id, {});
        } else if (failure.status === 400) {
          setQueued(queued().filter((o) => o.sendId !== m.sendId));
          toast(refusal(failure));
        } else setQueued(queued().map((o) => (o.sendId === m.sendId ? { ...o, failed: true } : o)));
        changed(m, !failure);
        settle(m);
      }
    } finally { flushing = false; }
  }
  // Whatever a reload left in the answer outbox goes out again, a failed one included, once the board first lands.
  function resend() {
    if (queued().some((m) => m.failed)) setQueued(queued().map(({ failed, ...m }) => m));
    // A file a reload left in an answer's box goes back in it (attach.js restore): one still uploading was lost.
    for (const m of queued()) for (const id of boxesOf(m)) if (!BoardAttach.list(boxOf(m, id), siteRoot).length) BoardAttach.restore(boxOf(m, id), m.uploads[id], siteRoot);
    for (const m of queued()) changed(m, false);
    flush();
  }
  // Retry sends a failed entry again in place; X drops it, its questions open again with their picks, notes and files.
  function retry(sendId) {
    const m = queued().find((o) => o.sendId === sendId);
    if (!m) return;
    setQueued(queued().map((o) => (o.sendId === sendId ? { ...o, failed: false } : o)));
    for (const id of boxesOf(m)) BoardAttach.retryFailed(boxOf(m, id), siteRoot);
    changed(m, false);
    settle(m);
    flush();
  }
  function drop(sendId) {
    const m = queued().find((o) => o.sendId === sendId);
    if (!m) return;
    setQueued(queued().filter((o) => o.sendId !== sendId));
    for (const id of boxesOf(m)) BoardAttach.move(boxOf(m, id), 'q:' + id, siteRoot);
    changed(m, false);
    settle(m);
  }
  const holds = (sendId) => queued().some((m) => m.sendId === sendId);
  // The board going out of reach or coming back redraws the open answers, sending… or waiting for the host, and once it
  // is back sends them.
  function linkChanged() {
    for (const m of queued()) settle(m);
    flush();
  }

  const newSendId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  on(sheet, 'submit', (ev) => {
    ev.preventDefault();
    const list = pending();
    if (!list.length) { status('Pick an option or write a note first.'); return; }
    status('');
    const sendId = newSendId();
    const key = keyOf(topic);
    const answers = list.map((q) => ({ ...BoardUI.answerOf(q, []), sendId }));
    const entry = { sendId, topic, ...(key ? { key } : {}), ts: new Date().toISOString(), answers,
      text: list.map((q, n) => `Question ${numberOf(q)} · ${q.question}\n→ ${[answers[n].label || answers[n].choice, answers[n].note].filter(Boolean).join(' · ')}`).join('\n\n') };
    const filed = list.filter((q) => attachedOf(q).length);
    for (const q of filed) BoardAttach.move('q:' + q.id, boxOf(entry, q.id), siteRoot);
    if (filed.length) entry.uploads = Object.fromEntries(filed.map((q) => [q.id, BoardAttach.saved(boxOf(entry, q.id), siteRoot)]));
    setQueued([...queued(), entry]);
    changed(entry, false);
    close();
    flush();
  });

  // docs/adr/2026-11-02-1822-each-question-has-its-own-prototype-eye.md, docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md
  // A question's Prototype, Grill or Visual puts `prototype-request`, `grill-more` or `visual-request {key?, question, note,
  // choice, sendId}` for that question in the outbox, its note box the note and its pick so far the choice. The question
  // reads its request and sending… at once; once the board has it the prototype's question leaves the sheet, the
  // grill's reads Grilling deeper and the visual's stays open.
  const REQUEST = { prototype: ['prototype-request', 'Prototype requested.'], grill: ['grill-more', 'Grill requested.'], visual: ['visual-request', 'Visual requested.'] };
  function ask(q, flag) {
    const [kind, said] = REQUEST[flag];
    const key = keyOf(q.topic);
    const d = getDraft(q.id);
    const sendId = newSendId();
    const entry = { sendId, id: q.id, topic: q.topic, ...(key ? { key } : {}), ts: new Date().toISOString(),
      request: { kind, said, data: { ...(key ? { key } : {}), question: q.id, note: noteOf(q, d).trim(), choice: choiceOf(q, d), sendId } } };
    status('');
    setQueued([...queued(), entry]);
    changed(entry, false);
    drawOne(q.id);
    flush();
  }

  BoardUI.wireAnswerForm(on, sheet, updateBar);
  // A pick or note saved on another device draws its card here, except the one whose note box is being typed in.
  atUnmount(BoardUI.questionDrafts.onTake((ids) => {
    if (!sheet.open) return;
    for (const id of ids) if (!sheet.querySelector(`section.q[data-q="${CSS.escape(id)}"] textarea:focus`)) drawOne(id);
  }));
  on(sheet, 'attach-change', updateBar);
  // An answer's box changing, an upload's progress, its end or an X on a failed file, draws its card again and keeps the
  // box for a reload.
  atUnmount(BoardAttach.onChange((box) => {
    const m = queued().find((o) => boxesOf(o).some((id) => boxOf(o, id) === box));
    if (!m) return;
    const id = boxesOf(m).find((x) => boxOf(m, x) === box);
    const saved = BoardAttach.saved(box, siteRoot);
    if (JSON.stringify(saved) !== JSON.stringify(m.uploads[id])) setQueued(queued().map((o) => (o.sendId === m.sendId ? { ...o, uploads: { ...o.uploads, [id]: saved } } : o)));
    changed(m, false);
    settle(m);
  }));
  on(sheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, sheet) || ev.target.closest?.('[data-qs="close"]')) { close(); return; }
    const again = ev.target.closest?.('section.q [data-resend], section.q [data-unsend]');
    if (again) { if (again.hasAttribute('data-resend')) retry(again.dataset.resend); else drop(again.dataset.unsend); return; }
    const request = ev.target.closest?.('section.q [data-proto], section.q [data-grill], section.q [data-visual]');
    if (!request || request.disabled) return;
    const q = board().owner.find((x) => x.id === request.closest('section.q').dataset.q);
    if (q) ask(q, BoardUI.requestOf(request));
  });
  // A non-modal sheet (from 900px) gets no cancel event from Escape, so the page's own key closes it, when on top.
  on(document, 'keydown', (ev) => { if (ev.key === 'Escape' && sheet.open && !modal && BoardUI.isTopSheet(sheet)) close(); });
  // Back on top from a sheet opened over it (ui.js openSheet), such as a prototype whose Choose this drafted a pick, it
  // draws its questions again from their drafts.
  on(sheet, 'sheet-return', redraw);
  atUnmount(BoardUI.swipeToDismiss(sheet));
  // The view going takes its sheet out of the sheet stack (ui.js openSheet).
  atUnmount(() => sheet.close());
  on(sheet, 'cancel', (ev) => { ev.preventDefault(); close(); });
  // A sheet closed and not shown again (ui.js restack closes and shows it at once) stops following the keyboard.
  on(sheet, 'close', () => { if (!sheet.open) unfitted(); });
  atUnmount(unfitted);

  return { open, followCard, leaveCard, shows, close, redraw, resend, retry, drop, holds, linkChanged, isOpen: () => sheet.open };
};
// docs/adr/2026-11-17-2000-the-questions-sheets-send-is-a-fixed-footer.md
// The sheet's dialog: the reader sheet's head, the cards scrolling in its body, and under them a footer with the status
// and Send, flush to the sheet's bottom edge. One form holds the body and the footer, so Send and ⌘↵ submit the cards.
BoardQuestionsSheet.markup = (attrs = '') => `<dialog class="sheet reader-sheet questions-sheet"${attrs}>
  <div class="reader-head"><h2>questions</h2><span class="reader-ref"></span><button type="button" class="ghost" data-qs="close" aria-label="Close">✕</button></div>
  <form class="qs-form"><div class="reader-body" tabindex="0"></div>
    <div class="qs-foot"><span class="muted small" id="qstatus" role="status"></span>${BoardUI.sendButton('Send', 0, ' id="send"')}</div></form>
</dialog>`;

// The board's sheet, over the lanes and the pane. Needs app-core.js and app-threads.js, whose card threads draw the
// answer outbox's lines (B.answerChanged).
BoardView.part((B) => {
  const { $, state } = B;
  const qs = BoardQuestionsSheet($('#questionsSheet'), {
    board: () => state.board, threads: (key) => state.threadCache.get(key), send: (kind, data, signal) => B.send(kind, data, null, { signal }),
    online: () => state.link === 'online', unreachable: () => B.linkDown(), toast: (text) => B.toast(text),
    on: B.on, atUnmount: B.atUnmount, alive: B.alive, store: B.store, changed: (m, sent) => B.answerChanged(m, sent), siteRoot: B.site.root,
  });
  // A card's Questions button or a thread's questions line opens it from its first question. They are buttons, not
  // links, so the router never sees them and the page and its history stay as they were.
  B.on(B.root, 'click', (ev) => {
    const button = ev.target.closest?.('button[data-questions]');
    if (button) qs.open(button.dataset.questions);
  });
  Object.assign(B, { openQuestionsSheet: qs.open, followCardQuestions: qs.followCard, leaveCardQuestions: qs.leaveCard, questionsSheetShows: qs.shows, closeQuestionsSheet: qs.close, resendAnswers: qs.resend, answersLinkChanged: qs.linkChanged, retryAnswer: qs.retry, dropAnswer: qs.drop, holdsAnswer: qs.holds });
});
