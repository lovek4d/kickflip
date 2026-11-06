// A card's thread on the board view: loading and rendering it, and its reply box. Needs app-core.js.
BoardView.part((B) => {
  const { $, store, state, toast, quieted, sendDraft, links } = B;
  const { esc, setHTML, threadMessages, dropZone, sendButton, protoButton, grillButton, boltButton, doneButton, waitOn, newQuestionsLine } = BoardUI;

  const REQUEST_EVENT = { prototype: 'prototype-request', grill: 'grill-more' };
  // A /prototype or /grill word in a message, the last one winning, and the message without it.
  const SLASH = /(^|\s)\/(grill|prototype)(?=\s|$)/g;
  const slashOf = (value) => ({ flag: [...value.matchAll(SLASH)].pop()?.[2] ?? null, text: value.replace(SLASH, '$1').replace(/ {2,}/g, ' ').trim() });

  const thread = (key) => `<div class="thread" data-thread="${esc(key)}"><div class="muted small">Loading thread…</div></div>`;

  // docs/adr/2026-11-04-2343-each-text-box-sends-its-intent-from-a-key.md,
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  // A Todo card's reply box sends with Reply (intent: 'reply') or Implement (intent: 'build'), which is the card's build
  // action: builder orange once the card is ready, quiet before. Any other card's box sends with Send, carrying no intent.
  // The pair wraps onto its own line under the row.
  const sendsOf = (item) => (item?.lane !== 'todo' ? 'one' : item.ready ? 'todo-ready' : 'todo');
  const sends = (kind) => (kind === 'one'
    ? `<span data-sends="one">${sendButton('Send', 0)}</span>`
    : `<span class="send-actions" data-sends="${kind}">${sendButton('Implement', 1, ` class="build${kind === 'todo-ready' ? ' ready' : ''}" data-intent="build"`)}${sendButton('Reply', 0, ' data-intent="reply"')}</span>`);
  // The board, not the thread, decides the Done button and the send buttons, so they follow each board load even when
  // the thread is unchanged.
  function syncDone(el, key) {
    const at = el.querySelector('form [data-sends]');
    if (!at) return;
    const item = state.board?.items.find((i) => i.key === key);
    const kind = sendsOf(item);
    const todo = item?.lane === 'todo';
    if (at.dataset.sends !== kind) { at.insertAdjacentHTML('afterend', sends(kind)); at.remove(); }
    const tools = el.querySelector('form .tools');
    const bolt = tools.querySelector('[data-bolt]');
    if (todo && !bolt) tools.insertAdjacentHTML('afterbegin', boltButton(key));
    else if (!todo) bolt?.remove();
    const html = doneButton(item);
    const current = el.querySelector('form [data-confirm="finish"]');
    if (current?.outerHTML === html) return;
    current?.remove();
    if (html) el.querySelector('form [data-sends]').insertAdjacentHTML('beforebegin', html);
  }

  // Each open card's ui-threads.js threadMessages view. Opening a card marks it seen (app-core.js markSeen) before its
  // thread draws, so its unread messages start from its read mark from before it opened (B.seenBefore). A board left
  // and opened again in this page keeps them, so its open threads show what they showed.
  const kept = B.place?.threads;
  const moreTaps = new Map(kept?.moreTaps);
  const firstDrawn = new Map(kept?.firstDrawn);
  B.keep(() => ({ threads: { moreTaps: [...moreTaps], firstDrawn: [...firstDrawn] } }));
  const seenAt = (key) => (B.seenBefore.has(key) ? B.seenBefore.get(key) : B.seen[key] || null);
  const newestTs = (msgs) => msgs.reduce((top, m) => [String(m.ts), m.reply?.at ? String(m.reply.at) : ''].reduce((a, b) => (b > a ? b : a), top), '');
  const viewOf = (key) => ({ seenAt: seenAt(key), more: moreTaps.get(key) || 0, upto: firstDrawn.get(key) || null });
  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item') || el.open) return;
    B.seenBefore.delete(el.dataset.key);
    moreTaps.delete(el.dataset.key);
    firstDrawn.delete(el.dataset.key);
  }, true);
  B.on(B.root, 'click', (ev) => {
    const key = ev.target.closest('[data-thread-more]')?.closest('[data-thread]')?.dataset.thread;
    if (key == null) return;
    moreTaps.set(key, (moreTaps.get(key) || 0) + 1);
    B.repaintThread(key);
  });

  const editsIn = (key) => new Map([...state.edits].filter(([, e]) => e.thread === key));
  function renderThread(key, msgs) {
    const el = $(`[data-thread="${CSS.escape(key)}"]`);
    if (!el) return;
    syncDone(el, key);
    const edits = editsIn(key);
    if (!firstDrawn.has(key) && msgs.length) firstDrawn.set(key, newestTs(msgs));
    const view = viewOf(key);
    const asked = newQuestionsLine(state.board?.items.find((i) => i.key === key)?.questions, seenAt(key));
    const lines = asked.length ? [...msgs, ...asked].sort((a, b) => String(a.ts).localeCompare(String(b.ts))) : msgs;
    const sig = JSON.stringify([lines, [...edits.keys()], view]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    // The reply form is built once per card, so a refresh never drops what is being typed.
    if (!el.querySelector('.msgs')) {
      const draft = store.get('draft:' + key, '');
      el.innerHTML = `<div class="msgs"></div><form data-reply="${esc(key)}" data-composer="item:${esc(key)}">${dropZone(`<textarea rows="2" placeholder="${esc(PLACEHOLDER)}">${esc(draft)}</textarea>`)}
        <div class="pending-files" data-files></div>
        <div class="row"><span class="tools">${protoButton(key)}${grillButton(key)}</span><button class="chip quick" type="button" data-quick="What's left?">What's left?</button>${sends('one')}</div></form>`;
      BoardAttach.paint('item:' + key, B.site.root);
    }
    syncDone(el, key);
    B.steady(() => setHTML(el.querySelector('.msgs'), threadMessages(lines, links(key), edits, view)));
    for (const id of edits.keys()) BoardAttach.paint('edit:' + id, B.site.root);
    B.flashChanged?.(el);
  }

  // docs/adr/2026-11-05-0430-the-eye-and-fire-send-their-request-at-once.md
  // The composer's eye asks for a prototype and its fire for a grill: a tap sends the request at once, with whatever is
  // typed, as /prototype or /grill in the text does on Reply. Nothing typed sends the bare request.
  const PLACEHOLDER = 'Reply in this thread… (/prototype or /grill asks for one)';

  // A load while one for the same thread runs shares it, so a card the page inserts open isn't fetched twice; force
  // starts a new one, after a send. maxAge skips a thread that loaded that recently. from is a load already started
  // (app.html BoardBoot). A response older than the one shown is dropped. A failed load keeps the previous render.
  const inflight = new Map();
  const loadedAt = new Map();
  const shown = new Map();
  let seq = 0;
  function loadThread(key, { force = false, maxAge = 0, from = null } = {}) {
    if (!force && inflight.has(key)) return inflight.get(key);
    if (maxAge && Date.now() - (loadedAt.get(key) || 0) < maxAge) return Promise.resolve();
    const n = ++seq;
    const p = (from || fetch(B.site.url('api/thread?key=' + encodeURIComponent(key)), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`thread ${r.status}`)))))
      .then((msgs) => {
        if ((shown.get(key) || 0) > n) return;
        shown.set(key, n);
        loadedAt.set(key, Date.now());
        state.threadCache.set(key, msgs);
        renderThread(key, msgs);
        B.saveCopySoon?.();
      })
      .catch(() => {})
      .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  B.on(B.root, 'input', (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f || ev.target.tagName !== 'TEXTAREA') return;
    if (quieted('draft:' + f.dataset.reply, ev.target)) return;
    store.set('draft:' + f.dataset.reply, ev.target.value);
  });
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-quick]');
    if (!b) return;
    const key = b.closest('form').dataset.reply;
    // Spins until the thread shows the message (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
    try { await waitOn(b, BoardUI.pending.within(B.sentHere(key, () => B.send('item-message', { key, text: b.dataset.quick })).then(() => loadThread(key, { force: true })), B.stillWaiting)); }
    catch (e) { B.failed(e); }
  });
  // docs/adr/2026-11-05-0010-a-lightning-button-in-a-todo-threads-footer-starts-a-quick-build.md
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-bolt]');
    if (!b) return;
    const key = b.dataset.bolt;
    try { await waitOn(b, B.sentHere(key, () => B.send('item-message', { key, text: 'Quick build', intent: 'build' }))); loadThread(key, { force: true }); }
    catch { toast('Could not send'); }
  });
  // Sends the composer's draft as one message, or as a request when flag names one; button spins until the thread has it.
  async function post(f, flag, button) {
    const ta = f.querySelector('textarea');
    ta.blur();
    const text = flag ? slashOf(ta.value).text : ta.value.trim();
    const id = f.dataset.composer;
    const files = BoardAttach.files(id, B.site.root);
    // An empty box still sends Implement, the card's build action.
    const intent = flag ? null : button.dataset.intent || null;
    if ((!flag && !text && !files.length && intent !== 'build') || BoardAttach.busy(id, B.site.root)) return;
    const key = f.dataset.reply;
    const data = { key, ...(text || !flag ? { text } : {}), ...(files.length ? { files } : {}), ...(intent ? { intent } : {}) };
    // Spins until the thread shows the message (docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md).
    const sending = (async () => {
      await sendDraft('draft:' + key, ta, () => $(`form[data-reply="${CSS.escape(key)}"] textarea`),
        () => B.sentHere(key, () => B.send(REQUEST_EVENT[flag] || 'item-message', data)));
      BoardAttach.clear(id, B.site.root);
      await loadThread(key, { force: true });
    })();
    try { await waitOn(button, BoardUI.pending.within(sending, B.stillWaiting)); } catch (e) { B.failed(e); }
  }
  B.on(B.root, 'click', (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-proto], form[data-reply] button[data-grill]');
    if (b) post(b.closest('form'), b.hasAttribute('data-proto') ? 'prototype' : 'grill', b);
  });
  B.on(B.root, 'submit', (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f) return;
    ev.preventDefault();
    post(f, slashOf(f.querySelector('textarea').value).flag, ev.submitter);
  });
  // A composer's send buttons wait while its files upload, the ask's included (attach.js attach-change).
  B.on(B.root, 'attach-change', (ev) => {
    for (const b of ev.target.querySelectorAll('button[type=submit]')) b.disabled = BoardAttach.busy(ev.detail.id, B.site.root);
    if (ev.target.matches?.('form[data-reply]')) for (const b of ev.target.querySelectorAll('button[data-proto], button[data-grill]')) b.disabled = BoardAttach.busy(ev.detail.id, B.site.root);
  });

  Object.assign(B, {
    thread, renderThread, loadThread,
    repaintThread: (key) => { if (state.threadCache.has(key)) renderThread(key, state.threadCache.get(key)); },
    syncDone: (key) => { const el = $(`[data-thread="${CSS.escape(key)}"]`); if (el) syncDone(el, key); },
  });
});
