// A card's thread on the board view: taking it from the board's sync or loading it, rendering it, and its reply box
// (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md). Needs app-core.js and ui-patch.js.
BoardView.part((B) => {
  const { $, store, state, links } = B;
  const { esc, setHTML, threadMessages, dropZone, sendButton, requestRow, requestOf, requestShown, slashOf, doneButton, doneTone, BUTTON } = BoardUI;

  const REQUEST_EVENT = { prototype: 'prototype-request', grill: 'grill-more', visual: 'visual-request', review: 'review-request' };

  const thread = (key) => `<div class="thread" data-thread="${esc(key)}"><div class="muted small">Loading thread…</div></div>`;

  // docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md,
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  // docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
  // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
  // Every card's reply box sends with Reply (intent: 'reply'), the second button of its pair beside it on ⌥↵: a Todo
  // card's Implement (intent: 'build'), its build action, while the card owes it, a quiet Cancel once it is staged or ready (it takes the card back to discussing); an In
  // Progress card's Block, quiet, which opens the Block sheet, or orange Unblock while the owner's block is on; an In Review
  // card's Done (ui-threads.js doneButton), in its tone; a Done card's Reopen, quiet. A card with no second button (one
  // not yet read from the board) has Reply alone. A pair wraps onto its own line under the row. Reply is orange while
  // a message clears the card's Action needed, as on a card the orchestrator stalled
  // (docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md).
  const replyTone = (item) => (item?.resolvedBy === BUTTON.reply ? 'resolves' : undefined);
  const laneSends = (item) => (item?.lane === 'todo' ? (item.ready ? 'todo-ready' : item.staging ? 'todo-staged' : 'todo')
    : item?.lane === 'review' ? ['review', doneTone(item)].filter(Boolean).join(' ')
    : item?.lane === 'progress' ? (item.ownerBlock ? 'progress-blocked' : 'progress')
    : item?.lane === 'done' ? 'done' : 'one');
  const sendsOf = (item) => [laneSends(item), item?.resolvedBy === BUTTON.implement && 'implement-resolves', replyTone(item) && 'reply-resolves', item?.sending && `sending-${item.sending.join("-")}`].filter(Boolean).join(' ');
  const pair = (kind, html) => `<span class="send-actions" data-sends="${kind}">${html}</span>`;
  const sends = (kind, item) => {
    const reply = sendButton('Reply', 0, ' data-intent="reply"', replyTone(item));
    // A second button whose tap is sending is disabled (ui.js SENDING) until the board answers (ui-snapshot.js tapped).
    const busy = (act) => (item?.sending?.includes(act) ? BoardUI.SENDING : '');
    const card = (label, act, cls = '') => sendButton(label, 1, `${cls ? ` class="${cls}"` : ''} data-confirm="${act}" data-key="${esc(item.key)}"${busy(act)}`);
    const second = kind.startsWith('todo-') ? card('Cancel', 'cancel')
      : kind.startsWith('todo') ? sendButton('Implement', 1, ` class="build${kind.includes('implement-resolves') ? ' resolves' : ''}" data-intent="build"${busy('build')}`)
      : kind.startsWith('review') ? doneButton(item)
      : kind.startsWith('progress-blocked') ? card('Unblock', 'resume', 'unblock')
      : kind.startsWith('progress') ? card('Block', 'hold')
      : kind.startsWith('done') ? card('Reopen', 'reopen') : '';
    return second ? pair(kind, `${second}${reply}`) : `<span data-sends="${kind}">${reply}</span>`;
  };
  // The board, not the thread, decides the send buttons, so they follow each board load even when the thread is unchanged.
  function syncSends(el, key) {
    const at = el.querySelector('form [data-sends]');
    if (!at) return;
    const item = BoardUI.tapped(state.board?.items.filter((i) => i.key === key) || [], outbox())[0];
    const kind = sendsOf(item);
    if (at.dataset.sends !== kind) { at.insertAdjacentHTML('afterend', sends(kind, item)); at.remove(); }
    // The row is built once and a card moves lanes without a rebuild, so its words follow the card's lane here: hidden
    // outside New and Todo (style.css), disabled while Implement or its own request sends (ui.js SENDING) and once the
    // card is staged or ready.
    el.dataset.requestWords = requestShown(item) ? 'shown' : 'hidden';
    for (const b of el.querySelectorAll('.request-row button')) {
      b.disabled = kind.startsWith('todo-') || Boolean(item?.sending?.includes('build') || item?.sending?.includes(requestOf(b)));
    }
  }

  // Each open card's ui-threads.js threadMessages view. Opening a card marks it seen (app-core.js markSeen) before its
  // thread draws, so its unread messages start from its read mark from before it opened (B.seenBefore). A board left
  // and opened again in this page keeps them, so its open threads show what they showed.
  const kept = B.place?.threads;
  const moreTaps = new Map(kept?.moreTaps);
  const firstDrawn = new Map(kept?.firstDrawn);
  const topEdge = new Map(kept?.topEdge);
  B.keep(() => ({ threads: { moreTaps: [...moreTaps], firstDrawn: [...firstDrawn], topEdge: [...topEdge] } }));
  const seenAt = (key) => (B.seenBefore.has(key) ? B.seenBefore.get(key) : B.seen[key] || null);
  const newestTs = (msgs) => msgs.reduce((top, m) => [String(m.ts), m.reply?.at ? String(m.reply.at) : ''].reduce((a, b) => (b > a ? b : a), top), '');
  const viewOf = (key) => ({ seenAt: seenAt(key), more: moreTaps.get(key) || 0, upto: firstDrawn.get(key) || null, from: topEdge.get(key) || null });
  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item') || el.open) return;
    B.seenBefore.delete(el.dataset.key);
    moreTaps.delete(el.dataset.key);
    firstDrawn.delete(el.dataset.key);
    topEdge.delete(el.dataset.key);
  }, true);
  B.on(B.root, 'click', (ev) => {
    const key = ev.target.closest('[data-thread-more]')?.closest('[data-thread]')?.dataset.thread;
    if (key == null) return;
    moreTaps.set(key, (moreTaps.get(key) || 0) + 1);
    B.holdBelow($(`[data-thread="${CSS.escape(key)}"]`), () => B.repaintThread(key));
  });
  // A fold in a thread, a run of status lines or a long output, opens and closes upward, whether tapped or keyed.
  B.on(B.root, 'click', (ev) => {
    const fold = ev.target.closest('[data-thread] .msgs summary')?.parentElement;
    if (!fold || ev.target.closest('a')) return;
    ev.preventDefault();
    B.holdBelow(fold.closest('[data-thread]'), () => { fold.open = !fold.open; });
  });

  // docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md,
  // docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
  // The outbox: the taps of a card's reply box that the board hasn't recorded yet, in send order, kept in this browser
  // under the board's own keys, so a reload keeps them. Each is {sendId, key, kind?, text, files, intent?, fields?, ts,
  // failed?}: kind is its event (item-message when absent), fields the rest of its event's data (a Block's hold and for).
  // The board records a sendId once (server.mjs), so a resend never doubles a tap.
  // docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md: every tap the board records goes through it,
  // whatever the link. While the board is out of reach a tap reads waiting for the host and nothing sends; once it is
  // back (linkChanged) the outbox sends on its own. A tap tied to a card, its bump included, draws in its thread; one
  // tied to none, a New strip ask's Delete or edit, or a review's Post it or Skip, has no key and draws in the New strip
  // in its said words, its event's data in fields.
  // docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md: the New task box's sends go
  // through it too, kind ask with no key, and queue apart from every card's; the New strip draws them (unsentAsks).
  // docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md: a New task with files is
  // atomic, and so is a thread reply's (docs/adr/2026-11-16-1030-a-thread-replys-and-an-answers-attachments-send-atomically-with-thumbnails.md).
  // Its files move, uploads still running, into its own box (sendBox, attach.js move), and uploads is that box
  // kept for a reload (attach.js saved); the send goes once every file is up, with them as its files, and an upload
  // that fails leaves it not sent. A reply's line draws the box's tiles meanwhile, as the New strip's row does.
  const outbox = () => store.get('outbox', []);
  const sendBox = (m) => `send:${m.sendId}`;
  // An entry's box as the drawing helpers read it (BoardUI.sentFiles), drawn from the box's files as they are now.
  const uploadsOf = (m) => ({ box: sendBox(m), list: BoardAttach.list(sendBox(m), B.site.root) });
  const queuedFor = (key) => outbox().filter((m) => m.key === key);
  const setOutbox = (list) => { store.set('outbox', list); BoardUI.outboxChanged(); };
  const eventOf = (m) => m.kind || 'item-message';
  const bodyOf = (m) => ({ ...(m.key ? { key: m.key } : {}), ...(m.text || !m.kind || m.kind === 'ask' ? { text: m.text } : {}), ...(m.files.length ? { files: m.files } : {}), ...(m.intent ? { intent: m.intent } : {}), ...m.fields, ...(m.version ? { version: m.version } : {}), sendId: m.sendId });
  // A card's sends draw in its thread, the New task box's in the New strip, which the board's first land draws when a
  // task is sent before it.
  const repaint = (key) => (key ? B.repaintThread(key) : state.board && B.renderNew(state.board));
  // Where an unsent tap is: not sent, waiting for the host while the board is offline (its load failed), else sending…,
  // a reconnect's included: it lasts under a second and the tap goes out the moment it is over.
  const pendingOf = (m) => (m.failed ? 'failed' : state.link === 'offline' ? 'held' : 'sending');
  // The New strip's rows for the keyless taps of the outbox the board d doesn't hold yet (ui-cards.js newEntry); once
  // it holds an ask, matched by its sendId, the board's own row takes its place. A New task whose send hasn't failed
  // has its Delete (withdraw). A Delete has no row: it marks its ask's (deletingIn).
  function unsentAsks(d) {
    const have = new Set(d.items.map((it) => it.ask?.sendId).filter(Boolean));
    return queuedFor(undefined).filter((m) => !have.has(m.sendId) && m.kind !== 'ask-withdrawn')
      .map((m) => ({ id: m.sendId, sent: m.ts, text: m.said ?? m.text, files: m.files, unsent: { sendId: m.sendId, state: pendingOf(m) },
        ...(m.kind === 'ask' && !m.failed ? { withdraw: true } : {}), ...(m.uploads ? { uploads: uploadsOf(m) } : {}) }));
  }
  // docs/adr/2026-11-18-2330-deleting-a-new-ask-reads-deleting-on-its-own-row.md
  // The asks whose Delete the board has, by ask id: each reads deleting… until the board d no longer lists it as new,
  // so its trash never comes back in between. → the New strip's ask id → {sendId?, state} of its Delete, where it is
  // while the outbox holds it, or null.
  const withdrawn = new Set();
  const withdrawalOf = (id) => outbox().find((o) => o.kind === 'ask-withdrawn' && o.fields.id === id);
  function deletingIn(d) {
    const listed = new Set(d.items.filter((it) => it.isNew).map((it) => it.ask.eventId));
    for (const id of withdrawn) if (!listed.has(id)) withdrawn.delete(id);
    return (id) => {
      const m = withdrawalOf(id);
      return m ? { sendId: m.sendId, state: pendingOf(m) } : withdrawn.has(id) ? { state: 'sending' } : null;
    };
  }
  // A New task's box changing, an upload's progress, its end or an X on a failed file, repaints its row and keeps the
  // box for a reload.
  B.atUnmount(BoardAttach.onChange((id) => {
    const m = outbox().find((o) => o.uploads && sendBox(o) === id);
    if (!m) return;
    const uploads = BoardAttach.saved(id, B.site.root);
    if (JSON.stringify(uploads) !== JSON.stringify(m.uploads)) setOutbox(outbox().map((o) => (o.sendId === m.sendId ? { ...o, uploads } : o)));
    repaint(m.key);
  }));
  // The line a tap draws until the board's own takes its place, in the board's words (domain.mjs COMMANDS, ACTION_LABELS,
  // INTENT_LABELS): with text or files the owner's message with the tap in its footer, else the tap's status line. waits:
  // whether a session picks the board's line up, so it reads waiting… once the board has it; the board applies a Block,
  // Unblock, Done, Reopen, Bump, Unbump, Tag… pick and bare Implement itself. A Merge's line is the board's on a held card; on a
  // card with a PR its own words stand until a thread load after the answer.
  const REQUESTED = { 'prototype-request': 'Prototype requested', 'grill-more': 'Grill requested', 'visual-request': 'Visual requested', 'review-request': 'Review requested' };
  const CARD_TAPS = { 'card-hold': (m) => (m.fields.hold ? 'Blocked' : 'Unblocked'), 'card-done': () => 'Marked done', 'card-reopen': () => 'Reopened', 'card-cancel': () => 'Cancelled Implement', 'card-merge': () => 'Merge requested',
    'card-bump': () => 'Moved to the top', 'card-unbump': () => 'Unbumped', 'tag-archive': (m) => `${m.fields.on ? 'Archived' : 'Restored'} the tag ${m.fields.tag}`, 'card-tag': (m) => `${m.fields.on ? 'Tagged' : 'Untagged'} ${m.fields.tag}` };
  function tapOf(m) {
    if (m.text || m.files.length || m.uploads) return { status: REQUESTED[m.kind] || (m.intent === 'build' ? 'Implement' : null), waits: true };
    return { words: REQUESTED[m.kind] || CARD_TAPS[m.kind]?.(m) || 'Marked as staged', waits: Boolean(REQUESTED[m.kind]) };
  }
  // landed: the board has it and the thread hasn't loaded its own line yet.
  const unsent = (m, landed = false) => {
    const { words, status, waits } = tapOf(m);
    const state = landed ? (waits ? 'waiting' : null) : pendingOf(m);
    return words ? { ts: m.ts, who: 'love', kind: 'command', request: true, mark: words, text: words, sendId: m.sendId, state }
      : { ts: m.ts, who: 'love', kind: 'item-message', text: m.text, files: m.files, ...(m.uploads ? { uploads: uploadsOf(m) } : {}), ...(status ? { status } : {}), sendId: m.sendId, state };
  };
  // The taps the board has recorded whose thread hasn't loaded since, by sendId: {m, at}, at the thread load count when
  // the board answered. The board's line carries the tap's sendId, so a thread holding it takes the tap's place at once,
  // whichever load it came from; a tap whose line has no sendId waits for a load started after the answer.
  // An answer from the questions sheet lands here too, as {m, line, at}, line its answer line reading waiting….
  const landed = new Map();
  const landedFor = (key, have) => [...landed.values()].filter((l) => l.m.key === key && !have.has(l.m.sendId)).map((l) => l.line || unsent(l.m, true));
  // docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md
  // A card tap that goes around the outbox, a script's Run or Decline or a Serve or Kill, which never send again on a
  // reload: postTap(key, words, request) draws its line in its card's thread, in the board's words (domain.mjs
  // COMMANDS), sending… while request is out. Answered, the line stands as landed until the thread loads the board's
  // own; refused, it goes, and the tap's toast says why. → request
  const posting = new Map();
  const postingFor = (key) => [...posting.values()].filter((p) => p.key === key).map((p) => p.line);
  function postTap(key, words, request) {
    const sendId = `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const line = { ts: new Date().toISOString(), who: 'love', kind: 'command', request: true, mark: words, text: words, sendId, state: 'sending' };
    posting.set(sendId, { key, line });
    B.repaintThread(key);
    const settle = (sent) => {
      posting.delete(sendId);
      if (!B.alive()) return;
      if (sent) landed.set(sendId, { m: { key, sendId }, line: { ...line, state: null }, at: seq });
      B.repaintThread(key);
      if (sent) loadThread(key, { force: true });
    };
    request.then(() => settle(true), () => settle(false));
    return request;
  }
  // docs/adr/2026-11-16-2100-a-question-sets-answers-send-as-one.md
  // The questions sheet's answer outbox (app-questions-sheet.js): each answer set to a card's questions is that card's one
  // answer line, in the board's words, its answers' files as tiles from each answer's box, until the board's own line,
  // carrying its sendId, takes its place.
  const answersFor = (key) => store.get(BoardUI.ANSWER_OUTBOX, []).filter((m) => m.key === key);
  // A question's prototype, grill or visual request in that outbox reads as the card's own request line.
  const requestLine = (m, state) => unsent({ ...m, kind: m.request.kind, text: m.request.data.note, files: [], fields: {} }, state === 'waiting');
  const answerUploads = (m) => Object.keys(m.uploads).map((id) => ({ box: BoardUI.answerBox(m.sendId, id), list: BoardAttach.list(BoardUI.answerBox(m.sendId, id), B.site.root) }));
  const answerLine = (m, state = pendingOf(m)) => m.request ? requestLine(m, state) : ({ ts: m.ts, who: 'love', via: 'questions', kind: 'owner-answer', text: m.text, files: m.answers.flatMap((a) => a.files || []), ...(m.uploads ? { uploads: answerUploads(m) } : {}), status: 'answers submitted', sendId: m.sendId, state });
  // After answer m changed in the outbox, its card's thread draws it; sent, the thread loads with the board's line,
  // the answer reading waiting… until then.
  function answerChanged(m, sent) {
    if (!m.key) return;
    if (sent && !(state.threadCache.get(m.key) || []).some((x) => x.sendId === m.sendId)) landed.set(m.sendId, { m, line: answerLine(m, 'waiting'), at: seq });
    B.repaintThread(m.key);
    if (sent) loadThread(m.key, { force: true });
  }

  function renderThread(key, msgs) {
    const el = $(`[data-thread="${CSS.escape(key)}"]`);
    if (!el) return;
    syncSends(el, key);
    if (!firstDrawn.has(key) && msgs.length) firstDrawn.set(key, newestTs(msgs));
    // The window's top edge is fixed when the card first draws, so a hidden message never pulls an older one in.
    if (!topEdge.has(key) && msgs.length) topEdge.set(key, BoardUI.threadFrom(msgs, viewOf(key)) || '');
    const view = viewOf(key);
    // The landed taps and then the outbox's follow everything the board has, in the order they were sent.
    const have = new Set(msgs.map((m) => m.sendId).filter(Boolean));
    const lines = [...msgs, ...landedFor(key, have), ...[...answersFor(key).map((m) => answerLine(m)), ...queuedFor(key).map((m) => unsent(m)), ...postingFor(key)].filter((m) => !have.has(m.sendId)).sort((a, b) => a.ts.localeCompare(b.ts))];
    const sig = JSON.stringify([lines, view]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    // The reply form is built once per card, so a refresh never drops what is being typed.
    if (!el.querySelector('.msgs')) {
      // Its draft lives on the board server (drafts.js), under the box's composer id.
      const draft = B.drafts.text('item:' + key);
      // The row: the request words, with the attach at their right, and the send buttons
      // (docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md).
      el.innerHTML = `<div class="msgs"></div><form data-reply="${esc(key)}" data-composer="item:${esc(key)}">${dropZone(`<textarea rows="2" placeholder="${esc(PLACEHOLDER)}">${esc(draft)}</textarea>`)}
        <div class="pending-files" data-files></div>
        <div class="row">${requestRow(key)}${sends('one')}</div></form>`;
      BoardAttach.paint('item:' + key, B.site.root);
    }
    syncSends(el, key);
    B.steady(() => setHTML(el.querySelector('.msgs'), threadMessages(lines, links(key), view)));
    B.flashChanged?.(el);
  }

  // docs/adr/2026-11-05-0430-the-eye-and-fire-send-their-request-at-once.md
  // The composer's Prototype asks for prototypes, its Grill for a grill and its Visual for a visual: a tap sends the request at
  // once, with whatever is typed, as /prototype, /grill or /visual in the text does on Reply. Nothing typed sends the
  // bare request (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md). /review, or the Review button,
  // asks for a reviewer (docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md).
  const PLACEHOLDER = 'Reply in this thread… (/prototype, /grill, /visual or /review asks for one)';

  // docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md: every card's thread rides the board's sync, so the page
  // holds them all (state.threadCache, saved with the board's copy) and opening a card loads nothing. A board patch's
  // threads go in through takeThreads; a whole board carries none, so fillThreads loads them. loadThread loads one
  // thread: a card the cache doesn't hold (a Done page loaded later, a first load still filling), a thread a patch
  // couldn't line up, and a forced reload after a send.
  // A load while one for the same thread runs shares it, so a card the page inserts open isn't fetched twice; force
  // starts a new one. from is a load already started (app.html BoardBoot). A response older than the one shown is
  // dropped. A failed load keeps the previous render.
  // docs/adr/2026-11-13-0230-a-card-reference-is-drawn-by-one-helper-with-its-lane-ring.md: after is the board load
  // fetched beside it, which settles once its board has landed; the thread draws then, so a line and the card change it
  // tells of (Created ticket and the header's ticket badge) show in one update.
  const inflight = new Map();
  const shown = new Map();
  // By key, the shown number of the last thread a board patch brought (takeThreads).
  const patched = new Map();
  let seq = 0;
  function loadThread(key, { force = false, from = null, after = null } = {}) {
    if (!force && inflight.has(key)) return inflight.get(key);
    const n = ++seq;
    const p = (from || fetch(B.site.url('api/thread?key=' + encodeURIComponent(key)), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`thread ${r.status}`)))))
      .then((msgs) => (after ? after.then(() => msgs) : msgs))
      .then((msgs) => {
        if ((shown.get(key) || 0) > n) return;
        shown.set(key, n);
        const have = new Set(msgs.map((m) => m.sendId).filter(Boolean));
        for (const [sendId, l] of landed) if (l.m.key === key && (have.has(sendId) || l.at < n)) landed.delete(sendId);
        state.threadCache.set(key, msgs);
        renderThread(key, msgs);
        B.checkShown();
        B.saveCopySoon?.();
      })
      .catch(() => {})
      .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  // A board patch's threads (ui-patch.js threadPatch) into the cache, before the board they came with draws them; a
  // thread the cache can't line up with its lines loads whole.
  function takeThreads(threads) {
    const { set, stale } = BoardUI.threadPatch(state.threadCache, threads);
    for (const [key, msgs] of set) {
      const n = ++seq;
      shown.set(key, n);
      patched.set(key, n);
      const have = new Set(msgs.map((m) => m.sendId).filter(Boolean));
      for (const [sendId, l] of landed) if (l.m.key === key && (have.has(sendId) || l.at < n)) landed.delete(sendId);
      state.threadCache.set(key, msgs);
    }
    for (const key of stale) loadThread(key, { force: true });
  }

  // After a board lands, the threads of the cards on it the cache lacks load, or with whole, after a whole board, which
  // carries no threads, every card's (ui-snapshot.js fillOrder): the open cards' at once, and the rest FILL_AT_ONCE at
  // a time, those the cache lacks first. → a promise of the open cards' loads.
  const FILL_AT_ONCE = 4;
  function fillThreads({ whole = false } = {}) {
    const lacks = (key) => whole || !state.threadCache.has(key);
    const order = BoardUI.fillOrder(state.board.items, state.openItems, state.threadCache);
    const open = order.open.filter(lacks);
    const rest = order.rest.filter(lacks);
    const next = () => { const key = rest.shift(); if (key !== undefined && B.alive()) loadThread(key).then(next); };
    for (let i = 0; i < FILL_AT_ONCE; i++) next();
    return Promise.all(open.map((key) => loadThread(key)));
  }

  // Sends key's outbox in order, one at a time, while the board is in reach: each leaves the outbox once the board has
  // it, and the thread loads with it in place while the next one goes. A send with no answer at all marks the board out
  // of reach (linkDown) and waits, with the ones behind it, for it to come back. One the board answers with an error,
  // or that has no answer in 15 s (ui.js sendWithin), stays as not sent and holds the ones behind it until Retry or X,
  // so the board gets them in the order they were written; a tap refused for a card that moved leaves with a toast
  // instead. A card tap's button waits while the tap is in the outbox (ui-snapshot.js tapped), and its card changes lane
  // only with the board's answer; a card tap's change of lane or hold changes the box's send buttons. The New task box's
  // asks (no key) go the same way; the board their answer lands holds each one's own New strip row.
  const flushing = new Set();
  async function flush(key) {
    if (flushing.has(key)) return;
    flushing.add(key);
    try {
      for (let m = queuedFor(key)[0]; m && !m.failed && state.link === 'online' && B.alive(); m = queuedFor(key)[0]) {
        if (m.uploads) {
          const up = await BoardAttach.settled(sendBox(m), B.site.root);
          if (!B.alive()) return;
          if (!up) {
            setOutbox(outbox().map((o) => (o.sendId === m.sendId ? { ...o, failed: true } : o)));
            repaint(key);
            continue;
          }
          const { uploads, ...rest } = m;
          m = { ...rest, files: BoardAttach.files(sendBox(m), B.site.root) };
          setOutbox(outbox().map((o) => (o.sendId === m.sendId ? m : o)));
          BoardAttach.clear(sendBox(m), B.site.root);
          repaint(key);
        }
        const was = patched.get(key);
        const send = () => BoardUI.sendWithin((signal) => B.send(eventOf(m), bodyOf(m), null, { signal }));
        try { await (key ? B.sentHere(key, send) : send()); }
        catch (e) {
          if (!B.alive()) return;
          if (e?.unreachable) { B.linkDown(); repaint(key); break; }
          // A tap the board refused because its card moved since it was drawn (409) changed nothing and would only be
          // refused again: it leaves the outbox, and the toast says where the card is.
          if (e?.status === 409) {
            setOutbox(outbox().filter((o) => o.sendId !== m.sendId));
            repaint(key);
            B.failed(e);
            continue;
          }
          setOutbox(outbox().map((o) => (o.sendId === m.sendId ? { ...o, failed: true } : o)));
          repaint(key);
          B.failed(e);
          continue;
        }
        if (m.kind === 'ask-withdrawn') withdrawn.add(m.fields.id);
        setOutbox(outbox().filter((o) => o.sendId !== m.sendId));
        if (!key) { repaint(key); continue; }
        // The send's answer, a board built after the board recorded the tap, patched in its thread with the board's own
        // line in it unless the thread couldn't line up; until then the tap shows as landed.
        if (patched.get(key) === was) landed.set(m.sendId, { m, at: seq });
        B.repaintThread(key);
        if (CARD_TAPS[m.kind]) B.syncSends(key);
        loadThread(key, { force: true });
      }
    } finally { flushing.delete(key); }
  }
  // A tap goes into the outbox and shows at once, and its button is free for the next. attached names a composer whose
  // files the tap takes into its own box, to send once they are all up.
  // A tap keeps the version of the card it was drawn on (domain.mjs version), which the board checks the card against.
  // said: a keyless tap's words in the New strip.
  function enqueue(key, { kind, text = '', files = [], intent, fields, attached, said } = {}) {
    const version = key && state.board?.items.find((i) => i.key === key)?.version;
    const m = { sendId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, key, ...(kind ? { kind } : {}), text, files, ...(intent ? { intent } : {}), ...(fields ? { fields } : {}), ...(said ? { said } : {}), ...(version ? { version } : {}), ts: new Date().toISOString() };
    if (attached) {
      BoardAttach.move(attached, sendBox(m), B.site.root);
      m.uploads = BoardAttach.saved(sendBox(m), B.site.root);
    }
    setOutbox([...outbox(), m]);
    repaint(key);
    flush(key);
  }
  // Whatever a reload left in the outbox goes out again, a failed send included, once the board first lands (app.js land).
  // A New task's files a reload left are put back in its box (attach.js restore): the uploaded ones go with it, and one
  // still uploading was lost, so the task reads not sent until it is removed.
  function resendOutbox() {
    const left = outbox();
    if (left.some((m) => m.failed)) setOutbox(left.map(({ failed, ...m }) => m));
    for (const m of left) if (m.uploads && !BoardAttach.list(sendBox(m), B.site.root).length) BoardAttach.restore(sendBox(m), m.uploads, B.site.root);
    flushAll();
  }
  const flushAll = () => { for (const key of new Set(outbox().map((m) => m.key))) { repaint(key); flush(key); } };
  // The board going out of reach or coming back (app-header.js setLink) redraws every unsent tap, sending… or waiting
  // for the host, and once it is back sends them, the questions sheet's answers too.
  function linkChanged() {
    flushAll();
    for (const key of new Set(store.get(BoardUI.ANSWER_OUTBOX, []).map((m) => m.key))) if (key) B.repaintThread(key);
    B.answersLinkChanged();
  }

  // The red not sent on an open card (ui-cards.js NOT_SENT) scrolls to the failed message's Retry instead of folding the card;
  // on a closed card the tap opens it, and its thread draws the message.
  B.on(B.root, 'click', (ev) => {
    const flag = ev.target.closest('[data-not-sent]');
    const card = flag?.closest('details.item[open]');
    if (!card) return;
    ev.preventDefault();
    card.querySelector('[data-resend]')?.scrollIntoView({ block: 'center' });
  });

  // Retry and X on a failed send, each after a confirm: Retry sends it again in place; X drops it and puts its text
  // back in the box, before whatever is typed there, a New task's in the New task box with its files, opened
  // (new-task.js reopenAsk); a keyless tap with said words has no box, and X only drops it. A bare tap's confirm names its line.
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('[data-thread] button[data-resend], [data-thread] button[data-unsend], #newStrip button[data-resend], #newStrip button[data-unsend]');
    if (!b) return;
    const retry = b.hasAttribute('data-resend');
    const sendId = retry ? b.dataset.resend : b.dataset.unsend;
    // An answer set's Retry and X are the questions sheet's, with no confirm: X loses nothing, its questions open again
    // with their picks and notes.
    if (B.holdsAnswer(sendId)) { if (retry) B.retryAnswer(sendId); else B.dropAnswer(sendId); return; }
    const tapped = outbox().find((o) => o.sendId === sendId);
    const words = tapped && (tapped.said || tapOf(tapped).words);
    // A Delete's X gives its ask's row its Delete back.
    const ask = tapped?.kind === 'ask-withdrawn' ? (retry ? 'Delete this task again?' : 'Dismiss the Delete? The task stays.')
      : tapped?.kind === 'ask' && !tapped.said ? (retry ? 'Send this task again?' : 'Dismiss this task? Its text and files go back in the New task box.')
      : words ? (retry ? `Send “${words}” again?` : `Dismiss “${words}”?`) : retry ? 'Send this message again?' : 'Dismiss this message? Its text goes back in the box.';
    if (!(await B.confirm(ask)) || !B.alive()) return;
    const m = outbox().find((o) => o.sendId === sendId);
    if (!m) return;
    // A New task's Retry first uploads again each of its files that failed, and sends once they are up.
    if (retry) {
      setOutbox(outbox().map((o) => (o.sendId === sendId ? { ...o, failed: false } : o)));
      if (m.uploads) BoardAttach.retryFailed(sendBox(m), B.site.root);
    } else {
      // A New task's X takes its Delete with it, which would name an ask the board never gets.
      setOutbox(outbox().filter((o) => o.sendId !== sendId && !(m.kind === 'ask' && o.kind === 'ask-withdrawn' && o.fields.id === sendId)));
      if (!m.key) { if (m.kind === 'ask') B.reopenAsk(m); } else {
        const ta = $(`form[data-reply="${CSS.escape(m.key)}"] textarea`);
        B.drafts.put('item:' + m.key, [m.text, ta?.value ?? B.drafts.text('item:' + m.key)].filter(Boolean).join('\n\n'));
        if (m.uploads) BoardAttach.move(sendBox(m), 'item:' + m.key, B.site.root);
      }
    }
    repaint(m.key);
    flush(m.key);
  });

  // Sends the composer's draft through the outbox, as a request when flag names one, else as a message with the tapped
  // button's intent; no button waits.
  async function post(f, flag, button) {
    const ta = f.querySelector('textarea');
    ta.blur();
    const text = flag ? slashOf(ta.value).text : ta.value.trim();
    const id = f.dataset.composer;
    const attached = BoardAttach.list(id, B.site.root).length > 0;
    // An empty box still sends Implement, the card's build action: the board server stages the card for the
    // orchestrator's review (docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md).
    const intent = flag ? null : button.dataset.intent || null;
    if (!flag && !text && !attached && intent !== 'build') return;
    const key = f.dataset.reply;
    await B.drafts.send(id, ta, () => $(`form[data-reply="${CSS.escape(key)}"] textarea`),
      async () => enqueue(key, { ...(flag ? { kind: REQUEST_EVENT[flag] } : {}), text, ...(attached ? { attached: id } : {}), ...(intent ? { intent } : {}) }));
  }
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-proto], form[data-reply] button[data-grill], form[data-reply] button[data-visual], form[data-reply] button[data-review]');
    if (b) post(b.closest('form'), requestOf(b), b);
  });
  B.on(B.root, 'submit', (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f) return;
    ev.preventDefault();
    // Block, Unblock, Done or Reopen on ⌥↵ (app-asks.js) does what its tap does (app-cards.js confirmTap).
    if (ev.submitter?.dataset.confirm) { B.confirmTap(ev.submitter); return; }
    post(f, slashOf(f.querySelector('textarea').value).flag, ev.submitter);
  });
  // docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md
  // A script offer's Run sends only after a hold of HOLD_MS, its bar filling meanwhile; letting go sooner sends nothing.
  // From the keyboard, which can't hold, Run asks a confirm instead. Run names the script's id and the sha of the text the
  // page drew; Decline confirms first. Neither goes through the outbox, so a reload never sends one again; each shows its
  // line in the thread while it sends (postTap), its button disabled meanwhile.
  const HOLD_MS = 900;
  let holding = null;
  const SCRIPT_WORDS = { 'script-run': 'Ran the script', 'script-decline': 'Declined the script' };
  const scriptTap = async (button, kind, data) => {
    const key = button.closest('[data-thread]')?.dataset.thread;
    if (!key) return;
    try { await BoardUI.waitOn(button, postTap(key, SCRIPT_WORDS[kind], B.send(kind, { key, ...data })), { quiet: true }); } catch (e) { B.failed(e); loadThread(key, { force: true }); }
  };
  const runOf = (b) => scriptTap(b, 'script-run', { id: b.dataset.scriptRun, sha: b.dataset.sha });
  const letGo = () => {
    if (!holding) return;
    clearTimeout(holding.timer);
    holding.button.classList.remove('holding');
    holding = null;
  };
  B.on(B.root, 'pointerdown', (ev) => {
    const b = ev.target.closest('[data-thread] button[data-script-run]');
    if (!b || ev.button !== 0) return;
    ev.preventDefault();
    letGo();
    b.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
    b.classList.add('holding');
    holding = { button: b, timer: setTimeout(() => { const held = holding.button; letGo(); runOf(held); }, HOLD_MS) };
  });
  for (const type of ['pointerup', 'pointercancel']) B.on(document, type, letGo);
  B.on(B.root, 'pointerout', (ev) => { if (holding && ev.target.closest('button[data-script-run]') === holding.button && !holding.button.contains(ev.relatedTarget)) letGo(); });
  B.on(B.root, 'contextmenu', (ev) => { if (ev.target.closest('button[data-script-run]')) ev.preventDefault(); });
  B.on(B.root, 'click', async (ev) => {
    const run = ev.target.closest('[data-thread] button[data-script-run]');
    if (run && ev.detail === 0 && await B.confirm('Run this script on the host? It can’t be undone.') && B.alive()) runOf(run);
    const decline = ev.target.closest('[data-thread] button[data-script-decline]');
    if (decline && await B.confirm('Decline this script? Nothing runs.') && B.alive()) scriptTap(decline, 'script-decline', { id: decline.dataset.scriptDecline });
  });

  Object.assign(B, {
    thread, renderThread, loadThread, takeThreads, fillThreads, resendOutbox, linkChanged, enqueue, postTap, unsentAsks, deletingIn, sendBox, answerChanged,
    repaintThread: (key) => { if (state.threadCache.has(key)) renderThread(key, state.threadCache.get(key)); },
    syncSends: (key) => { const el = $(`[data-thread="${CSS.escape(key)}"]`); if (el) syncSends(el, key); },
  });
});
