// A card's thread on the board view: loading and rendering it, and its reply box. Needs app-core.js.
BoardView.part((B) => {
  const { $, store, state, toast, quieted, sendDraft, links } = B;
  const { esc, setHTML, threadMessages, attachButton, protoButton, protoNotice, doneButton } = BoardUI;

  const thread = (key) => `<div class="thread" data-thread="${esc(key)}"><div class="muted small">Loading thread…</div></div>`;

  // The board, not the thread, decides the Done button, so it follows each board load even when the thread is unchanged.
  const sendingDone = new Set();
  function syncDone(el, key) {
    const send = el.querySelector('form button[type=submit]');
    if (!send) return;
    const html = doneButton(state.board?.items.find((i) => i.key === key), sendingDone.has(key));
    const current = el.querySelector('form [data-confirm="finish"]');
    if (current?.outerHTML === html) return;
    current?.remove();
    if (html) send.insertAdjacentHTML('beforebegin', html);
  }

  // Each open card's ui-threads.js threadMessages view. Opening a card marks it seen (app-core.js markSeen) before its
  // thread draws, so its unread messages start from its seen mark as the page loaded or as the card last closed.
  const seenBefore = new Map(Object.entries(B.seen));
  const moreTaps = new Map();
  const firstDrawn = new Map();
  const newestTs = (msgs) => msgs.reduce((top, m) => [String(m.ts), m.reply?.at ? String(m.reply.at) : ''].reduce((a, b) => (b > a ? b : a), top), '');
  const viewOf = (key) => ({ seenAt: seenBefore.get(key) || null, more: moreTaps.get(key) || 0, upto: firstDrawn.get(key) || null });
  B.on(B.root, 'toggle', (ev) => {
    const el = ev.target;
    if (!el.matches?.('details.item') || el.open) return;
    seenBefore.set(el.dataset.key, B.seen[el.dataset.key]);
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
    const sig = JSON.stringify([msgs, [...edits.keys()], view]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    // The reply form is built once per card, so a refresh never drops what is being typed.
    if (!el.querySelector('.msgs')) {
      const draft = store.get('draft:' + key, '');
      el.innerHTML = `<div class="msgs"></div><form data-reply="${esc(key)}" data-composer="item:${esc(key)}"><textarea rows="2" placeholder="Reply in this thread…">${esc(draft)}</textarea>
        <div class="pending-files" data-files></div>
        <div class="row">${attachButton()}${protoButton(key)}<button class="chip quick" type="button" data-quick="What's left?">What's left?</button><button class="primary" type="submit">Send</button></div></form>`;
      BoardAttach.paint('item:' + key, B.site.root);
    }
    syncDone(el, key);
    B.steady(() => setHTML(el.querySelector('.msgs'), threadMessages(msgs, links(key), edits, view)));
    B.flashChanged?.(el);
    // A thread's request is answered by a later thread line, so only a pending one changes the eye.
    const req = msgs.filter((m) => m.kind === 'prototype-request').pop();
    const proto = req && (req.state === 'waiting' || req.state === 'working') ? { pending: req.eventId } : null;
    const pb = el.querySelector('form [data-proto]');
    if (pb && pb.dataset.protoPending !== proto?.pending) pb.outerHTML = protoButton(key, proto);
  }

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
        B.saveSnapshotSoon?.();
      })
      .catch(() => {})
      .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  B.on(B.root, 'input', (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f || ev.target.tagName !== 'TEXTAREA' || quieted('draft:' + f.dataset.reply, ev.target)) return;
    store.set('draft:' + f.dataset.reply, ev.target.value);
  });
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-quick]');
    if (!b) return;
    const key = b.closest('form').dataset.reply;
    b.disabled = true;
    try { await B.site.send('item-message', { key, text: b.dataset.quick }); loadThread(key, { force: true }); }
    catch { toast('Could not send', 3000); }
    b.disabled = false;
  });
  B.on(B.root, 'click', async (ev) => {
    const b = ev.target.closest('form[data-reply] button[data-proto]');
    if (!b) return;
    const key = b.dataset.proto;
    const pending = b.dataset.protoPending;
    if (pending) {
      let latest = null;
      try { latest = (await B.site.events({ kind: 'ask-bump', limit: 1 }))[0]?.data?.id ?? null; } catch {}
      const n = protoNotice(pending, latest);
      if (!n.bump) { B.notice(n.text); return; }
      if (!(await B.confirm(n.text))) return;
      try { await B.site.send('ask-bump', { id: pending }); toast('Bumped to the top', 2500); } catch { toast('Could not bump', 3000); }
      return;
    }
    if (!(await B.confirm('Ask Claude for prototypes of this item?'))) return;
    b.disabled = true;
    try {
      await B.site.send('prototype-request', { key });
      b.title = b.ariaLabel = 'Prototypes asked for';
      toast('Asked Claude for prototypes', 2500);
      loadThread(key, { force: true });
    } catch { b.disabled = false; toast('Could not send', 3000); }
  });
  B.on(B.root, 'submit', async (ev) => {
    const f = ev.target.closest('form[data-reply]');
    if (!f) return;
    ev.preventDefault();
    const ta = f.querySelector('textarea');
    ta.blur();
    const text = ta.value.trim();
    const id = f.dataset.composer;
    const files = BoardAttach.files(id, B.site.root);
    if ((!text && !files.length) || BoardAttach.busy(id, B.site.root)) return;
    const key = f.dataset.reply;
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      await sendDraft('draft:' + key, ta, () => $(`form[data-reply="${CSS.escape(key)}"] textarea`),
        () => B.site.send('item-message', { key, text, ...(files.length ? { files } : {}) }));
      BoardAttach.clear(id, B.site.root);
      btn.disabled = false;
      loadThread(f.dataset.reply, { force: true });
    } catch { B.notice('Could not send. Is the Mac awake?'); btn.disabled = false; }
  });
  // Send waits while a composer's files upload, the ask's included (attach.js attach-change).
  B.on(B.root, 'attach-change', (ev) => {
    const b = ev.target.querySelector('button[type=submit]');
    if (b) b.disabled = BoardAttach.busy(ev.detail.id, B.site.root);
  });

  Object.assign(B, {
    thread, renderThread, loadThread, sendingDone,
    repaintThread: (key) => { if (state.threadCache.has(key)) renderThread(key, state.threadCache.get(key)); },
    syncDone: (key) => { const el = $(`[data-thread="${CSS.escape(key)}"]`); if (el) syncDone(el, key); },
  });
});
