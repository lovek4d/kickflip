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

  // Catches the saved copy of the board at key up to the hub's board with no page on it (shell.js keepFresh;
  // docs/adr/2026-11-15-1800-the-shell-keeps-every-sidebar-boards-saved-copy-fresh.md): by the changes since the copy's
  // number when build saved it, else whole, with every card's thread and notes loaded beside. get(url) → the answer's
  // JSON, rejecting on a failed one. → the saved board's number, or null when the copy was replaced meanwhile, which
  // the board's own page saved and so is no older.
  async function syncCopy(key, build, get) {
    const read = () => copyStore('boards', 'readonly', (store) => store.get(key));
    const was = await read();
    const copy = readCopy(was, build);
    const answer = await get(`${key}api/board${copy ? `?since=${copy.board.version}` : ''}`);
    const patched = copy && answer.since !== undefined;
    const threads = new Map(patched ? Object.entries(copy.threads) : []);
    const notes = new Map(patched ? Object.entries(copy.notes) : []);
    const board = patched ? globalThis.BoardUI.applyPatch(copy.board, answer) : answer;
    let stale = board.items.map((i) => i.key);
    if (patched) {
      const patch = globalThis.BoardUI.threadPatch(threads, answer.threads || {});
      for (const [k, msgs] of patch.set) threads.set(k, msgs);
      stale = patch.stale;
      for (const [k, md] of Object.entries(answer.notes || {})) if (md === null) notes.delete(k); else notes.set(k, md);
    } else {
      for (const [k, md] of Object.entries((await get(`${key}api/notes?all=1`)).notes)) notes.set(k, md);
    }
    for (let i = 0; i < stale.length; i += 4) {
      await Promise.all(stale.slice(i, i + 4).map(async (k) => threads.set(k, await get(`${key}api/thread?key=${encodeURIComponent(k)}`))));
    }
    const now = await read();
    if (now?.savedAt !== was?.savedAt || now?.build !== was?.build) return null;
    await copyStore('boards', 'readwrite', (store) => store.put(copyOf(board, threads, notes, { build, savedAt: board.generatedAt }), key));
    return board.version;
  }

  // The order a whole board's threads load in, since a whole board carries none (app-threads.js fillThreads): → {open,
  // rest}, open the keys of the open cards, which load at once, and rest every other card's, those held lacks first,
  // each in board order.
  const fillOrder = (items, open, held) => {
    const keys = items.map((i) => i.key);
    const shut = keys.filter((k) => !open.has(k));
    return { open: keys.filter((k) => open.has(k)), rest: [...shut.filter((k) => !held.has(k)), ...shut.filter((k) => held.has(k))] };
  };

  // The board's items as this browser's outbox has them drawn: a card whose Done is in the outbox, queued or in flight,
  // sits in Done and no longer offers Done, as the board will show it once it answers. A Done tapped with the thread
  // field focused (follow) stays where it is until then (app-core.js steady anchors on the field). A card whose Merge is
  // in it reads merging, its Merge busy, and one whose bump or unbump is in it carries its icon as bumped or not
  // (docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md), so a second tap never doubles one. A Todo card whose Implement is in it, not failed, reads staged, so its Implement draws as Cancel at the tap.
  const tapped = (items, outbox) => {
    const done = new Set(outbox.filter((m) => m.kind === 'card-done' && !m.follow).map((m) => m.key));
    const merging = new Set(outbox.filter((m) => m.kind === 'card-merge').map((m) => m.key));
    const bumps = new Map(outbox.filter((m) => m.kind === 'card-bump' || m.kind === 'card-unbump').map((m) => [m.fields.key, m.kind === 'card-bump' ? m.ts : null]));
    const implementing = new Set(outbox.filter((m) => m.intent === 'build' && !m.failed).map((m) => m.key));
    if (!done.size && !merging.size && !bumps.size && !implementing.size) return items;
    return items.map((i) => {
      let it = i;
      if (done.has(i.key)) it = { ...it, lane: 'done', finishable: false, phase: globalThis.BoardUI.PHASES.progress.includes(i.phase) ? null : i.phase };
      if (merging.has(i.key)) it = { ...it, merging: true };
      if (bumps.has(i.key)) it = { ...it, bumpedAt: bumps.get(i.key) };
      if (implementing.has(i.key) && i.lane === 'todo') it = { ...it, staging: !i.ready };
      return it;
    });
  };

  // The board's items as the answer outbox has them drawn: a card whose open questions all have an answer set in it,
  // sending or sent and not failed, draws as answered, with no Open items and its Questions button not orange, until the
  // board's snapshot shows them answered. A set that failed puts the card back as the board has it, and a card with a
  // question no set answers is untouched. owner: the board's questions; sets: the answer outbox (ui-questions.js ANSWER_OUTBOX).
  const answered = (items, sets, owner) => {
    const sent = new Set(sets.filter((m) => m.answers && !m.failed).flatMap((m) => m.answers.map((a) => a.id)));
    if (!sent.size) return items;
    const { ACTION_KIND, BUTTON } = globalThis.BoardUI;
    return items.map((it) => {
      if (!it.questions?.open) return it;
      const open = owner.filter((q) => q.topic === `item:${it.key}` && q.state === 'open');
      if (!open.length || !open.every((q) => sent.has(q.id))) return it;
      const asking = it.action?.kind === ACTION_KIND.questions || it.action?.kind === ACTION_KIND.pick;
      return { ...it, questions: { ...it.questions, open: 0, answered: it.questions.answered + it.questions.open }, action: asking ? null : it.action,
        resolvedBy: it.resolvedBy === BUTTON.openQuestions ? null : it.resolvedBy };
    });
  };

  // before and after map a line's id to its text; the ids of the lines that are new or read differently flash once.
  const changedLines = (before, after) => Object.keys(after).filter((id) => globalThis.BoardUI.record(before, id) !== after[id]);

  // What counts as a card's update: a new thread line, a lane, status or Next line change, or a PR or CI change
  // (docs/adr/2026-11-02-2354-an-updated-card-takes-a-brief-tint.md). Two board items read the same exactly when it is unchanged.
  const updateSign = (it) => JSON.stringify([it.threadCount ?? 0, it.lane ?? null, it.builder?.progress ?? null, it.working ?? null, it.waitsOn ?? null,
    it.next ?? null, it.ask?.state ?? null, ...(it.prs || []).map((pr) => [pr.state, pr.isDraft, pr.reviewDecision, pr.checks?.state ?? null])]);

  Object.assign(globalThis.BoardUI, { copyOf, readCopy, copyStore, syncCopy, pageCopy, boardCopy, fillOrder, tapped, answered, changedLines, updateSign });
})();
