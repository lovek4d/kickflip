// The last board this device showed, which the board page paints dimmed until the fresh board lands, and what the
// page may do meanwhile (docs/adr/0028-the-board-opens-on-the-last-visit.md). Needs ui.js.
(function () {
  const VERSION = 2;
  // Characters, one board's most; app-snapshot.js keeps every board's within three of these.
  const SNAPSHOT_MAX = 900000;
  const ACTIVE_LANES = ['review', 'stale', 'progress', 'todo'];

  // threads maps item keys to thread messages (app.js state.threadCache). Threads of `keep` go in first, then the
  // rest while they fit under max; threads of items no longer on the board are dropped. Null when the board alone won't fit.
  function packSnapshot(board, threads, { savedAt, keep = [], max = SNAPSHOT_MAX } = {}) {
    const head = `{"v":${VERSION},"savedAt":${JSON.stringify(savedAt)},"board":${JSON.stringify(board)},"threads":{`;
    if (head.length + 2 > max) return null;
    const onBoard = new Set(board.items.map((i) => i.key));
    let out = head;
    let n = 0;
    for (const key of new Set([...keep, ...threads.keys()])) {
      if (!onBoard.has(key) || !threads.has(key)) continue;
      const part = `${n ? ',' : ''}${JSON.stringify(key)}:${JSON.stringify(threads.get(key))}`;
      if (out.length + part.length + 2 > max) continue;
      out += part;
      n++;
    }
    return `${out}}}`;
  }

  // → {savedAt, board, threads: {key: messages}}, or null for anything packSnapshot didn't write.
  function unpackSnapshot(raw) {
    let s;
    try { s = JSON.parse(raw); } catch { return null; }
    if (s?.v !== VERSION || !Array.isArray(s.board?.items) || typeof s.savedAt !== 'string' || !Number.isFinite(Date.parse(s.savedAt))) return null;
    const threads = Object.fromEntries(Object.entries(s.threads && typeof s.threads === 'object' ? s.threads : {}).filter(([, m]) => Array.isArray(m)));
    return { savedAt: s.savedAt, board: s.board, threads };
  }

  // The cards whose threads load right after the board, so tapping one opens it filled; open cards load with the board.
  const preloadKeys = (items, open) => {
    const opened = new Set(open);
    return items.filter((i) => ACTIVE_LANES.includes(i.lane) && !opened.has(i.key)).map((i) => i.key);
  };

  // What the board page takes taps on. view is 'snapshot' while the last visit shows, 'fresh' once a board load landed,
  // and null before either. blocked selects the controls that send to the host and wait for the fresh board; style.css's
  // INT-61 block dims the same list.
  const SNAPSHOT_BLOCKED = ['.actions button', 'button[data-plan]', 'button[data-bump]', 'button[data-confirm="bump"]', 'button[data-edit]', 'button[data-withdraw]',
    'button[data-check-github]', 'form[data-reply] button[type=submit]', 'form[data-reply] button[data-quick]', 'form[data-reply] button[data-proto]', 'form[data-reply] button[data-confirm]', '.prompt button'].join(', ');
  const liveControls = (view) => {
    const fresh = view !== 'snapshot';
    return { read: true, ask: true, cards: fresh, send: fresh, blocked: fresh ? '' : SNAPSHOT_BLOCKED };
  };

  // before and after map a line's id to its text; the ids of the lines that are new or read differently flash once.
  const changedLines = (before, after) => Object.keys(after).filter((id) => globalThis.BoardUI.record(before, id) !== after[id]);

  Object.assign(globalThis.BoardUI, { packSnapshot, unpackSnapshot, preloadKeys, liveControls, changedLines, SNAPSHOT_MAX });
})();
