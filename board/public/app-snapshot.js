// The last visit's board on the board view: reading and saving it, holding the controls that send until the fresh
// board lands, and flashing the lines the fresh board changed (docs/adr/0028-the-board-opens-on-the-last-visit.md).
// Needs app-core.js and ui-snapshot.js; app.js paints it.
BoardView.part((B) => {
  const { $$, state } = B;
  const { packSnapshot, unpackSnapshot, preloadKeys, liveControls, changedLines } = BoardUI;
  // The hub serves every site from one origin, so each board keeps its own key.
  const KEY = 'boardSnapshot:' + B.site.url('');

  function readSnapshot() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch {}
    return raw ? unpackSnapshot(raw) : null;
  }
  let saveTimer = null;
  function saveSnapshot() {
    saveTimer?.();
    saveTimer = null;
    if (state.view !== 'fresh' || !state.board) return;
    const raw = packSnapshot(state.board, state.threadCache, {
      savedAt: state.board.generatedAt || new Date().toISOString(),
      keep: [...state.openItems, ...preloadKeys(state.board.items, [])],
    });
    try { if (raw) localStorage.setItem(KEY, raw); else localStorage.removeItem(KEY); } catch { try { localStorage.removeItem(KEY); } catch {} }
  }
  const saveSnapshotSoon = () => { if (!saveTimer) saveTimer = B.later(1000, saveSnapshot); };
  B.on(window, 'pagehide', () => { if (saveTimer) saveSnapshot(); });

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

  Object.assign(B, { readSnapshot, saveSnapshotSoon, setView, holdForFlash, flashChanged, endFlash });
});
