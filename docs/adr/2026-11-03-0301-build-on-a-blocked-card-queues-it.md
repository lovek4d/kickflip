---
status: superseded in part by 2026-11-04-0121-in-progress-has-a-queued-section and 2026-11-05-0802-todo-has-no-queue
---

# Build on a blocked card queues it, and blocked, bumped and Action needed leave the badges

Superseded in part by [Todo has no queue](2026-11-05-0802-todo-has-no-queue.md): Implement on a blocked card bumps it, with no queued build. The orange words on the time line and the bump icon stand.

Superseded in part by [In Progress has a Queued section, and the pull takes its top under the cap](2026-11-04-0121-in-progress-has-a-queued-section.md): a queued build waits in the Queued section and starts from its top once an implementer slot is free.

This supersedes in part [a Todo card that nothing blocks has Build](2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md) and [a held Todo card shows Build in place of Unhold](2026-11-03-0234-a-held-todo-card-shows-build-in-place-of-unhold.md), which gave Build only to cards nothing blocks; [a Build tap starts the build in the board server](2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md), which refused a blocked tap; [cards wait on explicit blocked-by links](2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md), on the Blocked by chips and on `card-unblocked` going out for every card a dep frees; [a card that hasn't started, or is running, can be bumped](2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md) and [a card can be held, and every card button confirms](2026-10-29-1639-a-card-can-be-held-and-every-card-button-confirms.md), on the bump confirming and dimming on the lane's latest bump; and [the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md), on Action needed being a badge.

**A blocked card's Build queues its build.**

- A Todo work card an unfinished dep blocks is `buildable` (`board/domain.mjs` `buildableOf`); the idle pull still skips it (`pullOf`). Its confirm reads "Build #80 once #53 is done? It waits in In Progress until then.", or "Unhold and build …" on a held card.
- The tap, in the board server (`store.mjs` `startTappedBuild`), refuses a pause and an unconfirmed prototype pick first, as before. A held card is unheld, as [a held Todo card shows Build in place of Unhold](2026-11-03-0234-a-held-todo-card-shows-build-in-place-of-unhold.md) says, then queued: its wave entry gets `queued_at`, the tap's time, and its thread "Build queued: it starts once #53 is done." Nothing else is made: no builder record, no worktree, no event, so the session isn't woken.
- **The queued card** is started for its lane (`started` counts `queued`), so it sits in In Progress, sorted by `queued_at` until a build agent's start replaces it. Its time line reads "10:26 · blocked by #53", and that fills the place of its builder line: `owesNext` is false for it and `buildBoard` gives it no "none set yet". A held queued card waits in Todo, held, like any held card.
- **The start.** When `item set` finishes a queued card's last dep, it prints `queued build starts: <key>` in place of `unblocked: <key>` and appends no `card-unblocked`, so no session starts it a second time; a held card's own pick-up skips its `card-unblocked` too. The board server, after every board change and every minute, starts each queued card that nothing holds or blocks (`dueQueuedBuilds`, `startQueuedBuild`) as the Build tap does: the pick, the worktree from the newest main, the tapped record, and `card-build {key, ref, kind, reason, worktree}` to wake the session. The pause line keeps cards queued. A start that is refused or fails clears `queued_at` and leaves "Couldn't start the build: …" on the card, back in Todo, so it isn't retried every minute.
- `item set --status building`, or a finished status, clears `queued_at`.

**The time line carries the orange words.** A card's last line reads its time, then held, then "blocked by #53, #54", each ref linking to its blocker's card, then Action needed, linking to what the owner acts on, then its new messages: "10:26 · held · blocked by #53 · Action needed · 2 new messages" (`board/public/ui-cards.js` `timeLine`). They leave the badge rows in every lane; the row under the chips keeps only the wave chip.

**The bump icon is the bump's only mark.** The bumped badge goes. A bumped work card's bump icon is filled orange (`.icon.bumped`, `var(--color-notice)`) and never disabled; tapping it sends `card-unbump {key}`, and tapping an unfilled one sends `card-bump {key}`, neither with a confirm. A bump counts until a later `card-unbump` for the card (`buildBoard`). A New card's bump icon is filled orange once bumped too, and still disabled on the latest bump, since an ask's bump has no unbump.

The owner on #67: "once it is marked blocked, you should still be able to trigger the build. It should just then go into in progress as blocked … maybe this makes me wonder if the blocked by should go after the timestamp in the same way that the held goes … we could get rid of the bumped badge because the icon uh does the job … maybe we can fill the icon in orange instead of dimming it." The grill settled that the build starts on its own from the newest main, and "Still goes before new messages." On #80: "I think action needed could also go where blocked goes. I'm thinking maybe action needed is the last one of the orange." And: "Drop confirmation for bumping and just allow unbumping by clicking the filled logo."

Considered:
- a tapped builder record with no worktree for the queued build: an open record makes the board busy for the idle pull, reads as a running builder and counts toward Stalled;
- waking the session on `card-unblocked` to start a queued card: the session's start and the server's would race, and the server already has every step;
- `card-bump {key, bump: false}` for the unbump: a session reading `card-bump` would take it as a bump.
