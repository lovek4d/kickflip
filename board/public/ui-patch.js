// Applies the board's patches on the page (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md): board/sync.mjs
// patchSince makes one from the change number the page holds, and the page applies it to the board it holds. Cards
// patch by key, questions and topics by id, each sent whole when it changed or dropped when gone, with the list's new
// order when that changed; every other part of the board comes whole when it changed. onHost rides beside the board,
// so it never moves the board's number.
(function () {
  const LISTS = { items: 'key', owner: 'id', ownerTopics: 'id' };

  // → a new board, leaving board as it was, or null when the patch was made against another version.
  function applyPatch(board, patch) {
    if (!board || board.version !== patch.since) return null;
    const next = { ...board, ...patch.set, version: patch.version, generatedAt: patch.generatedAt, onHost: patch.onHost };
    for (const k of patch.unset) delete next[k];
    for (const [name, p] of Object.entries(patch.lists)) {
      const id = LISTS[name];
      const gone = new Set(p.drop);
      const byId = new Map((board[name] || []).filter((r) => !gone.has(r[id])).map((r) => [r[id], r]));
      const fresh = p.set.filter((r) => !byId.has(r[id]));
      for (const r of p.set) byId.set(r[id], r);
      const order = p.order || [...(board[name] || []).map((r) => r[id]).filter((k) => !gone.has(k)), ...fresh.map((r) => r[id])];
      next[name] = order.map((k) => byId.get(k));
    }
    return next;
  }

  Object.assign(globalThis.BoardUI ||= {}, { applyPatch });
})();
