// The board view's saved copy: reading it from IndexedDB and saving it there with its change number
// (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md), flashing the lines the catch-up changed, and the sign
// on a card that changed lanes or was updated (docs/adr/2026-11-02-2354-an-updated-card-takes-a-brief-tint.md).
// Needs app-core.js and ui-snapshot.js; app.js paints it.
BoardView.part((B) => {
  const { $$, state } = B;
  const { copyOf, readCopy: checkCopy, preloadKeys, changedLines, updateSign } = BoardUI;
  // The hub serves every site from one origin, so each board keeps its own key in the one store.
  const KEY = B.site.url('');
  const BUILD = document.documentElement.dataset.build;

  // One transaction on the copies' store: fn(store) → the request whose result it resolves with. Rejects where
  // IndexedDB is missing or refuses, and the board then loads whole.
  function copies(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('kickflip-boards', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('boards');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('boards', mode);
        const req = fn(tx.objectStore('boards'));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  // → {savedAt, board, threads} or null.
  const readCopy = () => copies('readonly', (store) => store.get(KEY)).then((s) => checkCopy(s, BUILD), () => null);

  // Saves the board on screen. app.html's boot reads copyVersion before any script loads, so its first board request
  // asks since the copy's number; it names no number when the save failed.
  let saveTimer = null;
  async function saveCopy() {
    saveTimer?.();
    saveTimer = null;
    if (state.view !== 'fresh' || !state.board) return;
    const copy = copyOf(state.board, state.threadCache, { build: BUILD, savedAt: state.board.generatedAt || new Date().toISOString() });
    try {
      await copies('readwrite', (store) => store.put(copy, KEY));
      B.store.set('copyVersion', { build: BUILD, version: copy.board.version });
    } catch { B.store.set('copyVersion', null); }
  }
  const saveCopySoon = () => { if (!saveTimer) saveTimer = B.later(1000, saveCopy); };
  B.on(window, 'pagehide', () => { if (saveTimer) saveCopy(); });
  B.atUnmount(saveCopy);

  // view is null until a board paints, then 'fresh'.
  function setView(view) {
    state.view = view;
    B.root.dataset.board = view;
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
  // The one highlight: every changed line, moved card and updated card takes the full tint of style.css .tint. Re-adding
  // the class after a layout read restarts the animation, from the delay's point.
  function highlight(el, elapsed = 0) {
    el.classList.remove('tint');
    el.style.setProperty('--sign-delay', `-${elapsed}ms`);
    void el.offsetWidth;
    el.classList.add('tint');
  }
  const holdForFlash = () => { before = texts(lines()); };
  function flashChanged() {
    if (!before || state.view !== 'fresh') return;
    const els = lines();
    const after = texts(els);
    for (const id of changedLines(before, after)) {
      highlight(els.get(id));
      before[id] = after[id];
    }
  }
  const endFlash = () => { before = null; };

  // Since the page last drew it, a last visit's board included, a card that changed lanes, a work card that takes
  // the place of a drawn New task (its fromAsk), a work card or New task that joins Todo at the bottom, or any other
  // card whose updateSign changed takes the same tint. It does not show for a change the owner sent from this page:
  // sentHere(key, send) holds the card's next change unsigned until the first board load started after send settles.
  let drawn = new Map();
  const ownChanges = new Map();
  async function sentHere(key, send) {
    ownChanges.set(key, Infinity);
    try { return await send(); } finally { ownChanges.set(key, B.boardLoad || 0); }
  }
  // The tint's style.css animation length. A lane repaint resets a card's classes, so a tint still running is put back
  // as far into its animation as it was.
  const TINT_MS = 2400;
  const running = new Map();
  function signCards(load = null) {
    const now = Date.now();
    for (const it of state.board.items) {
      const was = drawn.get(it.key);
      const arrived = !was && drawn.size > 0 && it.lane === 'todo' && (it.isNew || (it.kind === 'work' && !it.fromAsk));
      const moved = was ? was.lane !== it.lane : arrived || (Boolean(it.fromAsk) && drawn.has(`ask:${it.fromAsk}`));
      const updated = Boolean(was) && was.sign !== updateSign(it);
      const own = ownChanges.get(it.key);
      if (own !== undefined) { if (moved || updated || (load !== null && load > own)) ownChanges.delete(it.key); continue; }
      if ((moved || updated) && state.view === 'fresh') running.set(it.key, now);
    }
    drawn = new Map(state.board.items.map((i) => [i.key, { lane: i.lane, sign: updateSign(i) }]));
    for (const [key, at] of running) {
      const card = now - at < TINT_MS && B.root.querySelector(`details.item[data-key="${CSS.escape(key)}"]`);
      if (!card) { running.delete(key); continue; }
      highlight(card, now - at);
    }
  }

  Object.assign(B, { readCopy, saveCopySoon, setView, holdForFlash, flashChanged, endFlash, highlight, sentHere, signCards });
});
