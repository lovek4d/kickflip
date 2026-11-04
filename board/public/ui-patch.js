// The board's per-card patches (docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md): server.mjs makes one
// from the board a page holds to the board now, and the page applies it to the board it holds. Cards patch by key,
// questions and topics by id, each sent whole when it changed or dropped when gone, with the list's new order when
// that changed; every other part of the board comes whole when it changed.
// Needs nothing else: board/server.mjs runs this file in a vm context.
(function () {
  const LISTS = { items: 'key', owner: 'id', ownerTopics: 'id' };
  const OWN = new Set(['version', 'generatedAt', ...Object.keys(LISTS)]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function listPatch(from, to, id) {
    const was = new Map(from.map((r) => [r[id], r]));
    const now = new Set(to.map((r) => r[id]));
    const set = to.filter((r) => !was.has(r[id]) || !same(was.get(r[id]), r));
    const drop = from.map((r) => r[id]).filter((k) => !now.has(k));
    if (!set.length && !drop.length && same(from.map((r) => r[id]), to.map((r) => r[id]))) return null;
    const placed = [...from.map((r) => r[id]).filter((k) => now.has(k)), ...to.map((r) => r[id]).filter((k) => !was.has(k))];
    const order = to.map((r) => r[id]);
    return { set, drop, ...(same(placed, order) ? {} : { order }) };
  }

  // from and to are page boards, each with its version. → {since, version, generatedAt, set, unset, lists}
  function boardPatch(from, to) {
    const set = {};
    for (const [k, v] of Object.entries(to)) if (!OWN.has(k) && (!(k in from) || !same(from[k], v))) set[k] = v;
    const unset = Object.keys(from).filter((k) => !OWN.has(k) && !(k in to));
    const lists = {};
    for (const [name, id] of Object.entries(LISTS)) {
      const p = listPatch(from[name] || [], to[name] || [], id);
      if (p) lists[name] = p;
    }
    return { since: from.version, version: to.version, generatedAt: to.generatedAt, set, unset, lists };
  }

  // → a new board, leaving board as it was, or null when the patch was made against another version.
  function applyPatch(board, patch) {
    if (!board || board.version !== patch.since) return null;
    const next = { ...board, ...patch.set, version: patch.version, generatedAt: patch.generatedAt };
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

  Object.assign(globalThis.BoardUI ||= {}, { boardPatch, applyPatch });
})();
