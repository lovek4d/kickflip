# A card can be held until a time

The owner asked on hub/INT-162 for "a flag to pick up at a certain time", then to "reuse snooze time selector (DRY) and make it pop up on held (allow held forever or for a time)", with "as much of this as possible … non skill, deterministic code".

- **A pick-up time is a timed Hold.** A card's Hold opens a sheet titled "Hold <ref>" with the shared duration picker ([0112](0112-snooze-and-keep-awake-share-one-duration-picker.md)): 1h, 3h, 6h, 1d, Forever and Custom. A chip is already a deliberate tap, so it replaces Hold's confirmation. Forever is the Hold that lasts until Resume; a time holds the card until then. Resume still confirms and names the time.
- **The event carries the time.** A chip sends `card-hold {key, hold: true, for}`, and the board server stores `{key, hold: true, until}` from `hub/duration.mjs` `durationEnd`, refusing a time past or more than 30 days on. The session records it with `board.mjs item set <key> --pick-up-at <until>`, which stores `pick_up_at` in UTC. `--pick-up-at` reads an ISO time without an offset as the Mac's local time, refuses a past time, and `""` resumes the card. `--held` holds with no time and `--unheld` resumes. Claude sets the same flag, or `item add --pick-up-at`, from the owner's words.
- **The board server ends the hold.** Within a minute of the time, its minute check resumes the card in the wave file, writes a thread line, and appends `card-unblocked {key, until}` unless a dep is unfinished. That is the event a finished dep sends, so the session starts the card, or carries on with one that had started, with no step of its own. The resumed wave file stops a second pick-up; the event log covers a restart between the event and that write. While usage is paused, watchers hold this event like any `card-unblocked` ([0094](0094-work-pauses-at-the-pause-line.md)).
- **No override.** A held card can't be bumped ([0019](0019-a-card-that-hasnt-started-can-be-bumped.md)) and `--status building` refuses it; to start early, resume it or change the time. No push goes when the time comes ([0006](0006-pushes-only-when-something-waits-on-the-owner.md)). A Linear due date stays a separate deadline.
- **No held chip.** The card's last line carries the hold after its time and before unread messages: "3:40 PM · held", or "3:40 PM · held until Wed 9:00 am · 2 new messages". The end reads as the time only today, the weekday within six days, and the date after that.

The board server writing the wave file at the pick-up time is the one exception to the session being the wave file's only writer for a hold ([0106](0106-the-board-applies-the-owners-hold-resume-and-done-at-once.md)). Expiry must not wait on a session that may be asleep or paused.

This supersedes in part [0023](0023-a-card-can-be-held-and-every-card-button-confirms.md): Hold no longer asks to confirm.

Considered:
- a pick-up time apart from Hold, blocking the card like a dep, with a "pick up Wed 11/4" chip in Todo: two ways to say "not yet" for one card;
- a timed hold that only woke the session, which then resumed the card: expiry would wait on a session step;
- a "held until" chip in place of the time line (take A of `timed-hold`): the owner dropped the held chip.
