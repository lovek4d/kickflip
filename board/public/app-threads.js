// A card's thread on the board view: taking it from the board's sync or loading it, rendering it, and its reply box
// (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md). Needs app-core.js and ui-patch.js.
BoardView.part((B) => {
  const { $, store, state, quieted, sendDraft, links } = B;
  const { esc, setHTML, threadMessages, dropZone, sendButton, protoButton, grillButton, visualButton, attachButton, doneButton, doneTone, BUTTON } = BoardUI;

  const REQUEST_EVENT = { prototype: 'prototype-request', grill: 'grill-more', visual: 'visual-request' };
  // A /prototype, /grill or /visual word in a message, the last one winning, and the message without it.
  const SLASH = /(^|\s)\/(grill|prototype|visual)(?=\s|$)/g;
  const slashOf = (value) => ({ flag: [...value.matchAll(SLASH)].pop()?.[2] ?? null, text: value.replace(SLASH, '$1').replace(/ {2,}/g, ' ').trim() });

  const thread = (key) => `<div class="thread" data-thread="${esc(key)}"><div class="muted small">Loading thread…</div></div>`;

  // docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md,
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  // docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md
  // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
  // Every card's reply box sends with Reply (intent: 'reply'), the second button of its pair beside it on ⌥↵: a Todo
  // card's Implement (intent: 'build'), its build action, builder orange once the card is ready, quiet before; an In
  // Progress card's Hold, quiet, which opens the Hold sheet, or orange Resume while the owner's hold is on; an In Review
  // card's Done (ui-threads.js doneButton), in its tone; a Done card's Reopen, quiet. A card with no second button (one
  // not yet read from the board) has Reply alone. A pair wraps onto its own line under the row. Reply is orange while
  // a message clears the card's Action needed, as on a card the orchestrator stalled
  // (docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md).
  const replyTone = (item) => (item?.resolvedBy === BUTTON.reply ? 'resolves' : undefined);
  const laneSends = (item) => (item?.lane === 'todo' ? (item.ready ? 'todo-ready' : 'todo')
    : item?.lane === 'review' ? ['review', doneTone(item)].filter(Boolean).join(' ')
    : item?.lane === 'progress' ? (item.held ? 'progress-held' : 'progress')
    : item?.lane === 'done' ? 'done' : 'one');
  const sendsOf = (item) => [laneSends(item), item?.resolvedBy === BUTTON.implement && 'implement-resolves', replyTone(item) && 'reply-resolves'].filter(Boolean).join(' ');
  const pair = (kind, html) => `<span class="send-actions" data-sends="${kind}">${html}</span>`;
  const sends = (kind, item) => {
    const reply = sendButton('Reply', 0, ' data-intent="reply"', replyTone(item));
    const card = (label, act, cls = '') => sendButton(label, 1, `${cls ? ` class="${cls}"` : ''} data-confirm="${act}" data-key="${esc(item.key)}"`);
    const second = kind.startsWith('todo') ? sendButton('Implement', 1, ` class="build${kind.startsWith('todo-ready') ? ' ready' : ''}${kind.includes('implement-resolves') ? ' resolves' : ''}" data-intent="build"`)
      : kind.startsWith('review') ? doneButton(item)
      : kind.startsWith('progress-held') ? card('Resume', 'resume', 'unhold')
      : kind.startsWith('progress') ? card('Hold', 'hold')
      : kind.startsWith('done') ? card('Reopen', 'reopen') : '';
    return second ? pair(kind, `${second}${reply}`) : `<span data-sends="${kind}">${reply}</span>`;
  };
  // The board, not the thread, decides the send buttons, so they follow each board load even when the thread is unchanged.
  function syncSends(el, key) {
    const at = el.querySelector('form [data-sends]');
    if (!at) return;
    const item = state.board?.items.find((i) => i.key === key);
    const kind = sendsOf(item);
    if (at.dataset.sends !== kind) { at.insertAdjacentHTML('afterend', sends(kind, item)); at.remove(); }
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
    B.repaintThread(key);
  });

  // docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md,
  // docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
  // The outbox: the taps of a card's reply box that the board hasn't recorded yet, in send order, kept in this browser
  // under the board's own keys, so a reload keeps them. Each is {sendId, key, kind?, text, files, intent?, fields?, ts,
  // failed?}: kind is its event (item-message when absent), fields the rest of its event's data (a Hold's hold and for).
  // The board records a sendId once (server.mjs), so a resend never doubles a tap.
  // docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md: the New task box's sends go
  // through it too, kind ask with no key, and queue apart from every card's; the New strip draws them (unsentAsks).
  const outbox = () => store.get('outbox', []);
  const queuedFor = (key) => outbox().filter((m) => m.key === key);
  const setOutbox = (list) => store.set('outbox', list);
  const eventOf = (m) => m.kind || 'item-message';
  const bodyOf = (m) => ({ ...(m.key ? { key: m.key } : {}), ...(m.text || !m.kind || m.kind === 'ask' ? { text: m.text } : {}), ...(m.files.length ? { files: m.files } : {}), ...(m.intent ? { intent: m.intent } : {}), ...m.fields, sendId: m.sendId });
  // A card's sends draw in its thread, the New task box's in the New strip, which the board's first land draws when a
  // task is sent before it.
  const repaint = (key) => (key ? B.repaintThread(key) : state.board && B.renderNew(state.board));
  // The New strip's rows for the asks of the outbox the board d doesn't hold yet (ui-cards.js newEntry); once it holds
  // one, matched by its sendId, the board's own row takes its place.
  function unsentAsks(d) {
    const have = new Set(d.items.map((it) => it.ask?.sendId).filter(Boolean));
    return queuedFor(undefined).filter((m) => !have.has(m.sendId))
      .map((m) => ({ id: m.sendId, sent: m.ts, text: m.text, files: m.files, unsent: { sendId: m.sendId, state: m.failed ? 'failed' : 'sending' } }));
  }
  // The line a tap draws until the board's own takes its place, in the board's words (domain.mjs COMMANDS, ACTION_LABELS,
  // INTENT_LABELS): with text or files the owner's message with the tap in its footer, else the tap's status line. waits:
  // whether a session picks the board's line up, so it reads waiting… once the board has it; the board applies a Hold,
  // Resume, Done, Reopen and bare Implement itself.
  const REQUESTED = { 'prototype-request': 'Prototype requested', 'grill-more': 'Grill requested', 'visual-request': 'Visual requested' };
  const CARD_TAPS = { 'card-hold': (m) => (m.fields.hold ? 'Held' : 'Resumed'), 'card-done': () => 'Marked done', 'card-reopen': () => 'Reopened' };
  function tapOf(m) {
    if (m.text || m.files.length) return { status: REQUESTED[m.kind] || (m.intent === 'build' ? 'Implement' : null), waits: true };
    return { words: REQUESTED[m.kind] || CARD_TAPS[m.kind]?.(m) || 'Marked as staging', waits: Boolean(REQUESTED[m.kind]) };
  }
  // landed: the board has it and the thread hasn't loaded its own line yet.
  const unsent = (m, landed = false) => {
    const { words, status, waits } = tapOf(m);
    const state = landed ? (waits ? 'waiting' : null) : m.failed ? 'failed' : 'sending';
    return words ? { ts: m.ts, who: 'love', kind: 'command', request: true, mark: words, text: words, sendId: m.sendId, state }
      : { ts: m.ts, who: 'love', kind: 'item-message', text: m.text, files: m.files, ...(status ? { status } : {}), sendId: m.sendId, state };
  };
  // The taps the board has recorded whose thread hasn't loaded since, by sendId: {m, at}, at the thread load count when
  // the board answered. The board's line carries the tap's sendId, so a thread holding it takes the tap's place at once,
  // whichever load it came from; a tap whose line has no sendId waits for a load started after the answer.
  const landed = new Map();
  const landedFor = (key, have) => [...landed.values()].filter((l) => l.m.key === key && !have.has(l.m.sendId)).map((l) => unsent(l.m, true));

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
    const lines = [...msgs, ...landedFor(key, have), ...queuedFor(key).filter((m) => !have.has(m.sendId)).map((m) => unsent(m))];
    const sig = JSON.stringify([lines, view]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    // The reply form is built once per card, so a refresh never drops what is being typed.
    if (!el.querySelector('.msgs')) {
      const draft = store.get('draft:' + key, '');
      // The row: What's left? at the left, the eye, fire, image and attach at its right, and the send buttons
      // (docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md).
      el.innerHTML = `<div class="msgs"></div><form data-reply="${esc(key)}" data-composer="item:${esc(key)}">${dropZone(`<textarea rows="2" placeholder="${esc(PLACEHOLDER)}">${esc(draft)}</textarea>`, { attach: false })}
        <div class="pending-files" data-files></div>
        <div class="row"><button class="chip quick" type="button" data-quick="What's left?">What's left?</button><span class="icons">${protoButton(key)}${grillButton(key)}${visualButton(key)}${attachButton()}</span>${sends('one')}</div></form>`;
      BoardAttach.paint('item:' + key, B.site.root);
    }
    syncSends(el, key);
    B.steady(() => setHTML(el.querySelector('.msgs'), threadMessages(lines, links(key), view)));
    B.flashChanged?.(el);
  }

  // docs/adr/2026-11-05-0430-the-eye-and-fire-send-their-request-at-once.md
  // The composer's eye asks for a prototype, its fire for a grill and its image for a visual: a tap sends the request at
  // once, with whatever is typed, as /prototype, /grill or /visual in the text does on Reply. Nothing typed sends the
  // bare request (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md).
  const PLACEHOLDER = 'Reply in this thread… (/prototype, /grill or /visual asks for one)';

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

  B.on(B.root, 'input', (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f || ev.target.tagName !== 'TEXTAREA') return;
    if (quieted('draft:' + f.dataset.reply, ev.target)) return;
    store.set('draft:' + f.dataset.reply, ev.target.value);
  });
  // Sends key's outbox in order, one at a time: each leaves the outbox once the board has it, and the thread loads
  // with it in place while the next one goes. A failed one stays as not sent and holds the ones behind it until Retry
  // or X, so the board gets them in the order they were written. A Done closes its card once the board answers
  // (app-cards.js closeCard); a card tap's change of lane or hold changes the box's send buttons. The New task box's
  // asks (no key) go the same way; the board their answer lands holds each one's own New strip row.
  const flushing = new Set();
  async function flush(key) {
    if (flushing.has(key)) return;
    flushing.add(key);
    try {
      for (let m = queuedFor(key)[0]; m && !m.failed && B.alive(); m = queuedFor(key)[0]) {
        const was = patched.get(key);
        const send = () => B.send(eventOf(m), bodyOf(m), m.kind === 'card-done' ? () => B.closeCard(key) : null);
        try { await (key ? B.sentHere(key, send) : send()); }
        catch (e) {
          setOutbox(outbox().map((o) => (o.sendId === m.sendId ? { ...o, failed: true } : o)));
          repaint(key);
          B.failed(e);
          continue;
        }
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
  // A tap goes into the outbox and shows at once, and its button is free for the next.
  function enqueue(key, { kind, text = '', files = [], intent, fields } = {}) {
    const m = { sendId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, key, ...(kind ? { kind } : {}), text, files, ...(intent ? { intent } : {}), ...(fields ? { fields } : {}), ts: new Date().toISOString() };
    setOutbox([...outbox(), m]);
    repaint(key);
    flush(key);
  }
  // Whatever a reload left in the outbox goes out again, a failed send included, once the board first lands (app.js land).
  function resendOutbox() {
    const left = outbox();
    if (left.some((m) => m.failed)) setOutbox(left.map(({ failed, ...m }) => m));
    for (const key of new Set(left.map((m) => m.key))) { repaint(key); flush(key); }
  }

  // Retry and X on a failed send, each after a confirm: Retry sends it again in place; X drops it and puts its text
  // back in the box, before whatever is typed there, a New task's in the New task box with its files, opened
  // (new-task.js reopenAsk). A bare tap's confirm names its line.
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('[data-thread] button[data-resend], [data-thread] button[data-unsend], #newStrip button[data-resend], #newStrip button[data-unsend]');
    if (!b) return;
    const retry = b.hasAttribute('data-resend');
    const sendId = retry ? b.dataset.resend : b.dataset.unsend;
    const tapped = outbox().find((o) => o.sendId === sendId);
    const words = tapped && tapOf(tapped).words;
    const ask = tapped?.kind === 'ask' ? (retry ? 'Send this task again?' : 'Dismiss this task? Its text and files go back in the New task box.')
      : words ? (retry ? `Send “${words}” again?` : `Dismiss “${words}”?`) : retry ? 'Send this message again?' : 'Dismiss this message? Its text goes back in the box.';
    if (!(await B.confirm(ask)) || !B.alive()) return;
    const m = outbox().find((o) => o.sendId === sendId);
    if (!m) return;
    if (retry) setOutbox(outbox().map((o) => (o.sendId === sendId ? { ...o, failed: false } : o)));
    else {
      setOutbox(outbox().filter((o) => o.sendId !== sendId));
      if (!m.key) B.reopenAsk(m);
      else {
        const ta = $(`form[data-reply="${CSS.escape(m.key)}"] textarea`);
        const text = [m.text, ta?.value ?? store.get('draft:' + m.key, '')].filter(Boolean).join('\n\n');
        if (ta) ta.value = text;
        store.set('draft:' + m.key, text);
      }
    }
    repaint(m.key);
    flush(m.key);
  });

  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-quick]');
    if (!b) return;
    enqueue(b.closest('form').dataset.reply, { text: b.dataset.quick });
  });
  // Sends the composer's draft through the outbox, as a request when flag names one, else as a message with the tapped
  // button's intent; no button waits.
  async function post(f, flag, button) {
    const ta = f.querySelector('textarea');
    ta.blur();
    const text = flag ? slashOf(ta.value).text : ta.value.trim();
    const id = f.dataset.composer;
    const files = BoardAttach.files(id, B.site.root);
    // An empty box still sends Implement, the card's build action: the board server stages the card for the
    // orchestrator's review (docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md).
    const intent = flag ? null : button.dataset.intent || null;
    if ((!flag && !text && !files.length && intent !== 'build') || BoardAttach.busy(id, B.site.root)) return;
    const key = f.dataset.reply;
    await sendDraft('draft:' + key, ta, () => $(`form[data-reply="${CSS.escape(key)}"] textarea`),
      async () => enqueue(key, { ...(flag ? { kind: REQUEST_EVENT[flag] } : {}), text, files, ...(intent ? { intent } : {}) }));
    BoardAttach.clear(id, B.site.root);
  }
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-proto], form[data-reply] button[data-grill], form[data-reply] button[data-visual]');
    if (b) post(b.closest('form'), b.hasAttribute('data-proto') ? 'prototype' : b.hasAttribute('data-grill') ? 'grill' : 'visual', b);
  });
  B.on(B.root, 'submit', (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f) return;
    ev.preventDefault();
    // Hold, Resume, Done or Reopen on ⌥↵ (app-asks.js) does what its tap does (app-cards.js confirmTap).
    if (ev.submitter?.dataset.confirm) { B.confirmTap(ev.submitter); return; }
    post(f, slashOf(f.querySelector('textarea').value).flag, ev.submitter);
  });
  // A composer's send buttons wait while its files upload (attach.js attach-change). The New task box's stay free: a
  // tap there spins until the upload finishes, then sends (new-task.js).
  B.on(B.root, 'attach-change', (ev) => {
    if (ev.target.matches?.('#askForm')) return;
    for (const b of ev.target.querySelectorAll('button[type=submit]')) b.disabled = BoardAttach.busy(ev.detail.id, B.site.root);
    if (ev.target.matches?.('form[data-reply]')) for (const b of ev.target.querySelectorAll('button[data-proto], button[data-grill], button[data-visual]')) b.disabled = BoardAttach.busy(ev.detail.id, B.site.root);
  });

  Object.assign(B, {
    thread, renderThread, loadThread, takeThreads, fillThreads, resendOutbox, enqueue, unsentAsks,
    repaintThread: (key) => { if (state.threadCache.has(key)) renderThread(key, state.threadCache.get(key)); },
    syncSends: (key) => { const el = $(`[data-thread="${CSS.escape(key)}"]`); if (el) syncSends(el, key); },
  });
});
