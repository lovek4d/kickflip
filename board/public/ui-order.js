// The board's order of its items, each lane together, which board/domain.mjs sorts the board by and the page sorts a
// tap it draws at once by, so the card lands where the server will put it
// (docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md). Each item carries its lane, isNew, bumpedAt, sortAt, order and key.
// Needs nothing else: board/domain.mjs runs this file in a vm context.
(function () {
  const LANE_ORDER = { review: 0, progress: 1, todo: 2, done: 3, asks: 4 };
  // Every lane but Done lists bumped cards first, the earliest bump on top, a bumped New ask included
  // (docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md,
  // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md). Todo lists the rest oldest first by sortAt, a card with no
  // time last, the first added to its wave file on top, so a New ask and every new card join the bottom and the pull takes the
  // top ready card (docs/adr/2026-11-05-2345-new-todo-cards-join-the-bottom.md,
  // docs/adr/2026-11-06-0300-a-new-task-lands-at-the-bottom-of-todo-and-flashes-blue.md). Every other
  // lane lists its cards newest first by sortAt, a card with no time last, the last added to its wave file on top.
  // Present times first, the earliest on top.
  const earliest = (x, y) => (x ? 0 : 1) - (y ? 0 : 1) || String(x || '').localeCompare(String(y || ''));
  function laneOrder(a, b) {
    const at = (i) => String(i.sortAt || '');
    const oldestFirst = a.lane === 'todo';
    const timeless = (i) => (at(i) ? 0 : 1);
    const age = oldestFirst ? timeless(a) - timeless(b) || at(a).localeCompare(at(b)) : at(b).localeCompare(at(a));
    const added = a.lane !== 'todo' ? b.order - a.order : a.order - b.order;
    return LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || earliest(a.bumpedAt, b.bumpedAt) || age || added || a.key.localeCompare(b.key);
  }
  Object.assign(globalThis.BoardUI ||= {}, { laneOrder });
})();
