// The last visit's board on the board view: reading and saving it, holding the controls that send until the fresh
// board lands, and flashing the lines the fresh board changed (docs/adr/0028-the-board-opens-on-the-last-visit.md)
// and the cards that changed lanes.
// Needs app-core.js and ui-snapshot.js; app.js paints it.
BoardView.part((B) => {
  const { $$, state } = B;
  const { packSnapshot, unpackSnapshot, preloadKeys, liveControls, changedLines, SNAPSHOT_MAX } = BoardUI;
  // The hub serves every site from one origin, so each board keeps its own key.
  const KEY = 'boardSnapshot:' + B.site.url('');
  // Every board's snapshots together stay within three at ui-snapshot.js's cap, the boards saved least recently
  // dropping first, so they leave room in the browser's 5 MB of storage for the drafts and seen marks, which would
  // otherwise fail to save.
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

  // The lines a fresh board can change: each card line, lane count, Needs you line and thread message.
  function lines() {
    const out = new Map();
    for (const wrap of $$('details.item[data-key] > summary .title-wrap')) {
      const key = wrap.closest('[data-key]').dataset.key;
      [...wrap.children].forEach((el, i) => out.set(`${key}|${i}`, el));
    }
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
      const el = els.get(id);
      (el.closest('details.item') || el).classList.add('flash');
      before[id] = after[id];
    }
  }
  const endFlash = () => { before = null; };

  // A card whose lane changed since the page last drew it, a last visit's board included, flashes once in its new
  // lane, as does a work card that takes the place of a drawn New task (its fromAsk), unless the owner moved it from
  // this page: movingHere(key, send) holds the card's next lane change unflashed until the first board load started
  // after send settles.
  let drawnLanes = new Map();
  const ownMoves = new Map();
  async function movingHere(key, send) {
    ownMoves.set(key, Infinity);
    try { return await send(); } finally { ownMoves.set(key, B.boardLoad || 0); }
  }
  function flashMoved(load = null) {
    for (const it of state.board.items) {
      const moved = drawnLanes.has(it.key) ? drawnLanes.get(it.key) !== it.lane : Boolean(it.fromAsk) && drawnLanes.has(`ask:${it.fromAsk}`);
      const own = ownMoves.get(it.key);
      if (own !== undefined) { if (moved || (load !== null && load > own)) ownMoves.delete(it.key); continue; }
      const el = moved && state.view === 'fresh' && B.root.querySelector(`details.item[data-key="${CSS.escape(it.key)}"]`);
      if (!el) continue;
      // Re-adding the class after a layout read restarts a flash still running.
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    drawnLanes = new Map(state.board.items.map((i) => [i.key, i.lane]));
  }

  Object.assign(B, { readSnapshot, saveSnapshotSoon, setView, holdForFlash, flashChanged, endFlash, movingHere, flashMoved });
});
