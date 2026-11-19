# Every hub limit takes the same turns

Status: accepted (owner, T-754: "also should include round robin for test lands etc. all limits should use the same
queue mechanism in the end"; t749-turns "Strict rotation, one card per board per turn", t749-caps "Both caps move to
the hub; boards keep no limit", t749-board-rows "Remove the rows; caps live only in hub settings", 11/18)

Card #1105 (T-754), split from #1092 (T-749). Extends [one hub-wide build cap, boards take turns](2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md)
to every capped queue on the host. Amends [land test runs take turns on the host](2026-11-16-0700-land-test-runs-take-turns-on-the-host.md),
[a merge tap waits its turn to land](2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md) and
[a bump goes first in every queue](2026-11-19-0242-a-bump-goes-first-in-every-queue.md) in their queue order, and
[a card's serve stays up while its worktree does](2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md) in
who holds Maximum parallel serves.

## Decision

- **One queue order for every hub limit**, `shared/turns.mjs` `inTurns`: bumped waiters first, the earliest bump first
  whichever board it is on; then round the boards in order of their site from the one after the board the last turn
  went to, one waiter each per turn, each board's in its own order; a board with nothing waiting gives its turn up.
  `turnAfter` moves the turn to the board of the last unbumped waiter served: a bump moves no turn and never stops
  running work (T-744's rule). Waiters with no board share one turn, named `''`.
- **The limits that follow it:**
  - Build slots, Maximum tasks in progress (`board/build-turns.mjs turnsOf`), unchanged in effect.
  - Land test slots, Maximum parallel land tests (`board/worktree.mjs holdingTestSlot`), and the land lock, one land at a
    time (`holdingLandLock`): `queuedAsks` orders a queue's asks by `inTurns`, each board's by when asked, and
    `~/.claude/kickflip/<queue>.turn` `{last}` holds the board the queue's last turn went to. The ask that takes the
    lock or a slot moves the turn on; every waiting ask watches the turn file too, so a moved turn wakes them all to
    read their place again.
  - Card serves, Maximum parallel serves (`hub/try.mjs`): now one hub number, `settings.json` `serves`, 1 to 99, 10
    unless set (`hub-settings.mjs readServes`), counting every board's card serves. Auto serve's tick gathers the serves
    that need a new slot across the boards it ticks and starts as many as are free in turn order; the hub process holds
    the last board served. A serve that takes no new slot (a card already serving, a resume, an app board) starts at
    once as before. The owner's Serve past the cap is refused, now naming Hub settings.
- **The Capacity section** holds the three numbers in order: Maximum tasks in progress, Maximum parallel serves (posting
  `/_hub/settings/serves`), Maximum parallel land tests, each saying boards take turns. Board Settings loses its
  Maximum parallel serves row; `max_serves` leaves `api/settings`, `settings set` and `settings` lines, and a board's old
  key is ignored and dropped by its next save. No per-board value is carried over.

## Consequences

- A board that queues several lands no longer holds the land lock and the test slots for all of them while another
  board's land waits: the boards alternate.
- The land and test queues' order still puts bumps first, earliest first, so `moveQueuedLand` works as before.
- The hub knows no bumps for serves: a serve waiter's bump is always null, so serves take plain turns.
