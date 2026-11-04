// The board's order of its items, each lane together, which board/domain.mjs sorts the board by and the page sorts a
// tap it draws at once by, so the card lands where the server will put it
// (docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md). Each item carries its lane, isNew, queued, bumpedAt, sortAt, order and key.
// Needs nothing else: board/domain.mjs runs this file in a vm context.
(function () {
  const LANE_ORDER = { review: 0, stale: 1, progress: 2, todo: 3, done: 4, asks: 5 };
  // New cards lead Todo, oldest first, so the top one is the next taken (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md);
  // then bumped cards, the latest bump on top (docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md); then the rest
  // newest first by sortAt, a card with no time last, the last added to its wave file on top. Todo's Queued cards
  // lead it, bumped first and then oldest first, so the top one is the next to build
  // (docs/adr/2026-11-04-0150-queued-sits-at-the-top-of-todo.md).
  function laneOrder(a, b) {
    const bumped = (i) => i.bumpedAt || '';
    const unsorted = (i) => (i.isNew ? 0 : 1);
    const queued = (i) => (i.queued ? 1 : 0);
    const at = (i) => String(i.sortAt || '');
    const age = a.isNew || a.queued ? at(a).localeCompare(at(b)) : at(b).localeCompare(at(a));
    return LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || queued(b) - queued(a) || unsorted(a) - unsorted(b) || bumped(b).localeCompare(bumped(a)) || age || b.order - a.order || a.key.localeCompare(b.key);
  }
  Object.assign(globalThis.BoardUI ||= {}, { laneOrder });
})();
