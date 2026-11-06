// The board this device last held, saved in IndexedDB with its change number, which the board page paints live on open
// and catches up from (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md). Needs ui.js.
(function () {
  const ACTIVE_LANES = ['review', 'stale', 'progress', 'todo'];

  // threads maps item keys to thread messages (app.js state.threadCache). → {build, savedAt, board, threads} with the
  // threads of the cards on the board; build is the saving page's (app.html data-build).
  const copyOf = (board, threads, { build, savedAt }) => {
    const onBoard = new Set(board.items.map((i) => i.key));
    return { build, savedAt, board, threads: Object.fromEntries([...threads].filter(([key]) => onBoard.has(key))) };
  };

  // → {savedAt, board, threads}, or null for anything copyOf didn't write under this build: code from another build may
  // read the board's shape differently, and a paint that throws stops the live load.
  function readCopy(s, build) {
    if (s?.build !== build || !Array.isArray(s.board?.items) || !Number.isInteger(s.board.version) || typeof s.savedAt !== 'string' || !Number.isFinite(Date.parse(s.savedAt))) return null;
    const threads = Object.fromEntries(Object.entries(s.threads && typeof s.threads === 'object' ? s.threads : {}).filter(([, m]) => Array.isArray(m)));
    return { savedAt: s.savedAt, board: s.board, threads };
  }

  // The cards whose threads load right after the board, so tapping one opens it filled; open cards load with the board.
  const preloadKeys = (items, open) => {
    const opened = new Set(open);
    return items.filter((i) => ACTIVE_LANES.includes(i.lane) && !opened.has(i.key)).map((i) => i.key);
  };

  // before and after map a line's id to its text; the ids of the lines that are new or read differently flash once.
  const changedLines = (before, after) => Object.keys(after).filter((id) => globalThis.BoardUI.record(before, id) !== after[id]);

  // What counts as a card's update: a new thread line, a status or Next line change, or a PR or CI change
  // (docs/adr/2026-11-02-2354-an-updated-card-takes-a-brief-tint.md). Two board items read the same exactly when it is unchanged.
  const updateSign = (it) => JSON.stringify([it.threadCount ?? 0, it.status ?? null, it.builder?.progress ?? null, it.working ?? null, it.waitsOn ?? null,
    it.next ?? null, it.ask?.state ?? null, ...(it.prs || []).map((pr) => [pr.state, pr.isDraft, pr.reviewDecision, pr.checks?.state ?? null])]);

  Object.assign(globalThis.BoardUI, { copyOf, readCopy, preloadKeys, changedLines, updateSign });
})();
