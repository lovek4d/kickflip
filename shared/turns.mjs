// docs/adr/2026-11-19-0800-every-hub-limit-takes-the-same-turns.md
// The hub's one queue order, which every capped queue on the host follows: build slots (board/build-turns.mjs), card
// serves (hub/try.mjs), land test slots and the land lock (board/worktree.mjs). A waiter is {site, first, ...}: site the
// board it is for (null for none, which counts as one board named ''), first its bump's time or null.

const siteOf = (waiter) => waiter.site ?? '';

// waiters, each board's in its own order, and last the board the last turn went to. → the waiters in the order the
// next free places go to them: bumped ones first, the earliest bump first whichever board it is on, then round the
// boards in order of site from the one after last, one each per turn, a board with nothing left giving its turn up.
export function inTurns(waiters, last = null) {
  const bumped = waiters.filter((x) => x.first).sort((a, b) => Date.parse(a.first) - Date.parse(b.first));
  const boards = new Map();
  for (const x of waiters.filter((x) => !x.first)) boards.set(siteOf(x), [...(boards.get(siteOf(x)) || []), x]);
  const sites = [...boards.keys()].sort();
  const order = last === null ? sites : [...sites.filter((s) => s > last), ...sites.filter((s) => s <= last)];
  const out = [...bumped];
  for (let turn = 0; out.length < waiters.length; turn++) {
    for (const site of order) if (boards.get(site)[turn]) out.push(boards.get(site)[turn]);
  }
  return out;
}

// The board the turns stand at once the waiters taken, from the head of inTurns, have their places: the last unbumped
// one's, since a bump moves no turn, else last.
export function turnAfter(taken, last = null) {
  const turn = taken.filter((x) => !x.first).at(-1);
  return turn ? siteOf(turn) : last;
}
