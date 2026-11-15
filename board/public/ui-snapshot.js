// The board this device last held, saved in IndexedDB with its change number and every card's thread and notes, which
// the board page paints live on open and catches up from (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md,
// docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md, docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md).
// Needs ui.js.
(function () {
  // threads maps item keys to thread messages (app.js state.threadCache) and notes to their markdown (state.notesCache),
  // which the board's sync keeps for every card on it. → {build, savedAt, board, threads, notes} with those of the cards
  // on the board; build is the saving page's (app.html data-build).
  const copyOf = (board, threads, notes, { build, savedAt }) => {
    const onBoard = new Set(board.items.map((i) => i.key));
    const kept = (map) => Object.fromEntries([...map].filter(([key]) => onBoard.has(key)));
    return { build, savedAt, board, threads: kept(threads), notes: kept(notes) };
  };

  // → {savedAt, board, threads, notes}, or null for anything copyOf didn't write under this build: code from another
  // build may read the board's shape differently, and a paint that throws stops the live load.
  function readCopy(s, build) {
    if (!s || s.build !== build || !Array.isArray(s.board?.items) || !Number.isInteger(s.board.version) || typeof s.savedAt !== 'string' || !Number.isFinite(Date.parse(s.savedAt))) return null;
    const entries = (v, ok) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, x]) => ok(x)));
    return { savedAt: s.savedAt, board: s.board, threads: entries(s.threads, Array.isArray), notes: entries(s.notes, (x) => typeof x === 'string') };
  }

  // One transaction on a store of the copies' database: 'boards', each board's copy, or 'pages', a side page's answers
  // (pageCopy). fn(store) → the request whose result it resolves with. Rejects where IndexedDB is missing or refuses.
  function copyStore(name, mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('kickflip-boards', 2);
      open.onupgradeneeded = () => { for (const s of ['boards', 'pages']) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(name, mode);
        const req = fn(tx.objectStore(name));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  // A side page's last answer from each URL it reads, Notes' and Settings', for showing while the board can't be reached
  // (docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md). read(url) → {savedAt, body} or null.
  const pageCopy = {
    save: (url, body) => copyStore('pages', 'readwrite', (store) => store.put({ savedAt: new Date().toISOString(), body }, url)).catch(() => {}),
    read: (url) => copyStore('pages', 'readonly', (store) => store.get(url)).then((c) => (typeof c?.savedAt === 'string' ? c : null), () => null),
  };

  // The copy of the board at key, the board view's site URL: the copy build saved, or with build null any build's.
  // → {savedAt, board, threads} or null.
  const boardCopy = (key, build) => copyStore('boards', 'readonly', (store) => store.get(key)).then((s) => readCopy(s, build ?? s?.build), () => null);

  // The order a whole board's threads load in, since a whole board carries none (app-threads.js fillThreads): → {open,
  // rest}, open the keys of the open cards, which load at once, and rest every other card's, those held lacks first,
  // each in board order.
  const fillOrder = (items, open, held) => {
    const keys = items.map((i) => i.key);
    const shut = keys.filter((k) => !open.has(k));
    return { open: keys.filter((k) => open.has(k)), rest: [...shut.filter((k) => !held.has(k)), ...shut.filter((k) => held.has(k))] };
  };

  // before and after map a line's id to its text; the ids of the lines that are new or read differently flash once.
  const changedLines = (before, after) => Object.keys(after).filter((id) => globalThis.BoardUI.record(before, id) !== after[id]);

  // What counts as a card's update: a new thread line, a lane, status or Next line change, or a PR or CI change
  // (docs/adr/2026-11-02-2354-an-updated-card-takes-a-brief-tint.md). Two board items read the same exactly when it is unchanged.
  const updateSign = (it) => JSON.stringify([it.threadCount ?? 0, it.lane ?? null, it.builder?.progress ?? null, it.working ?? null, it.waitsOn ?? null,
    it.next ?? null, it.ask?.state ?? null, ...(it.prs || []).map((pr) => [pr.state, pr.isDraft, pr.reviewDecision, pr.checks?.state ?? null])]);

  Object.assign(globalThis.BoardUI, { copyOf, readCopy, copyStore, pageCopy, boardCopy, fillOrder, changedLines, updateSign });
})();
