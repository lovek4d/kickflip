// The last visit's board on the board view: reading and saving it, holding the controls that send until the fresh
// board lands, flashing the lines the fresh board changed (docs/adr/2026-10-29-1639-the-board-opens-on-the-last-visit.md), and
// the sign on a card that changed lanes or was updated (docs/adr/2026-11-02-2354-an-updated-card-takes-a-brief-tint.md).
// Needs app-core.js and ui-snapshot.js; app.js paints it.
BoardView.part((B) => {
  const { $$, state } = B;
  const { packSnapshot, unpackSnapshot, preloadKeys, liveControls, changedLines, updateSign, SNAPSHOT_MAX } = BoardUI;
  // The hub serves every site from one origin, so each board keeps its own key.
  const KEY = 'boardSnapshot:' + B.site.url('');
  // Every board's snapshots together stay within three at ui-snapshot.js's cap, the boards saved least recently
  // dropping first, so they leave room in the browser's 5 MB of storage for the drafts, which would otherwise fail to
  // save.
  const BUDGET = 3 * SNAPSHOT_MAX;
  const ORDER = 'boardSnapshots';
  const BUILD = document.documentElement.dataset.build;

  function readSnapshot() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch {}
    return raw ? unpackSnapshot(raw, BUILD) : null;
  }
  // Makes room for this board's raw snapshot.
  function keepRecent(raw) {
    let order = [];
    try { order = JSON.parse(localStorage.getItem(ORDER) || '[]'); } catch {}
    const stored = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('boardSnapshot:') && k !== KEY) stored.push(k); }
    const recent = [...order.filter((k) => stored.includes(k)), ...stored.filter((k) => !order.includes(k))];
    let used = raw.length;
    const kept = [KEY];
    for (const k of recent) {
      const size = localStorage.getItem(k)?.length || 0;
      if (used + size <= BUDGET) { used += size; kept.push(k); } else localStorage.removeItem(k);
    }
    localStorage.setItem(ORDER, JSON.stringify(kept));
  }
  let saveTimer = null;
  function saveSnapshot() {
    saveTimer?.();
    saveTimer = null;
    if (state.view !== 'fresh' || !state.board) return;
    const raw = packSnapshot(state.board, state.threadCache, {
      build: BUILD,
      savedAt: state.board.generatedAt || new Date().toISOString(),
      keep: [...state.openItems, ...preloadKeys(state.board.items, [])],
    });
    try {
      if (!raw) { localStorage.removeItem(KEY); return; }
      keepRecent(raw);
      localStorage.setItem(KEY, raw);
    } catch { try { localStorage.removeItem(KEY); } catch {} }
  }
  const saveSnapshotSoon = () => { if (!saveTimer) saveTimer = B.later(1000, saveSnapshot); };
  B.on(window, 'pagehide', () => { if (saveTimer) saveSnapshot(); });
  // The app shell paints a board it comes back to from this, live when nothing changed since (shell.js).
  B.atUnmount(saveSnapshot);

  // view is ui-snapshot.js liveControls' view; style.css dims the snapshot and its held controls from the view root's data-board.
  function setView(view) {
    state.view = view;
    B.root.dataset.board = view;
  }
  for (const type of ['click', 'submit']) {
    B.on(B.root, type, (ev) => {
      const { blocked } = liveControls(state.view);
      if (!blocked) return;
      const control = type === 'submit' ? ev.target.querySelector?.('button[type=submit]') : ev.target.closest?.(blocked);
      if (control?.matches(blocked)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }, true);
  }

  // The lines a fresh board can change: each lane count, Needs you line and thread message. A card shows its own sign below.
  function lines() {
    const out = new Map();
    for (const count of $$('.lane[data-lane] > summary .count')) out.set(`lane:${count.closest('.lane').dataset.lane}`, count);
    $$('#waiting li').forEach((li, i) => out.set(`needs:${i}`, li));
    for (const msgs of $$('[data-thread] > .msgs')) [...msgs.children].forEach((m, i) => out.set(`thread:${msgs.parentElement.dataset.thread}|${i}`, m));
    return out;
  }
  const texts = (els) => Object.fromEntries([...els].map(([id, el]) => [id, el.textContent.replace(/\s+/g, ' ').trim()]));
  let before = null;
  const holdForFlash = () => { before = texts(lines()); };
  function flashChanged() {
    if (!before || state.view !== 'fresh') return;
    const els = lines();
    const after = texts(els);
    for (const id of changedLines(before, after)) {
      els.get(id).classList.add('flash');
      before[id] = after[id];
    }
  }
  const endFlash = () => { before = null; };

  // Since the page last drew it, a last visit's board included, a card that changed lanes, a work card that takes
  // the place of a drawn New task (its fromAsk), or a work card that joins Todo at the bottom, flashes once; any other card whose updateSign changed takes a brief
  // tint on its title row. Neither shows for a change the owner sent from this page: sentHere(key, send) holds the
  // card's next change unsigned until the first board load started after send settles.
  let drawn = new Map();
  const ownChanges = new Map();
  async function sentHere(key, send) {
    ownChanges.set(key, Infinity);
    try { return await send(); } finally { ownChanges.set(key, B.boardLoad || 0); }
  }
  // Each sign's style.css animation length. A lane repaint resets a card's classes, so a sign still running is put back
  // as far into its animation as it was.
  const SIGNS = { flash: 1600, tint: 2400 };
  const running = new Map();
  function signCards(load = null) {
    const now = Date.now();
    for (const it of state.board.items) {
      const was = drawn.get(it.key);
      const arrived = !was && drawn.size > 0 && it.kind === 'work' && it.lane === 'todo' && !it.fromAsk;
      const moved = was ? was.lane !== it.lane : arrived || (Boolean(it.fromAsk) && drawn.has(`ask:${it.fromAsk}`));
      const updated = Boolean(was) && was.sign !== updateSign(it);
      const own = ownChanges.get(it.key);
      if (own !== undefined) { if (moved || updated || (load !== null && load > own)) ownChanges.delete(it.key); continue; }
      if ((moved || updated) && state.view === 'fresh') running.set(it.key, { sign: moved ? 'flash' : 'tint', at: now });
    }
    drawn = new Map(state.board.items.map((i) => [i.key, { lane: i.lane, sign: updateSign(i) }]));
    for (const [key, { sign, at }] of running) {
      const card = now - at < SIGNS[sign] && B.root.querySelector(`details.item[data-key="${CSS.escape(key)}"]`);
      if (!card) { running.delete(key); continue; }
      // Re-adding the class after a layout read restarts the animation, from the delay's point.
      card.classList.remove('flash', 'tint');
      card.style.setProperty('--sign-delay', `-${now - at}ms`);
      void card.offsetWidth;
      card.classList.add(sign);
    }
  }

  Object.assign(B, { readSnapshot, saveSnapshotSoon, setView, holdForFlash, flashChanged, endFlash, sentHere, signCards });
});
