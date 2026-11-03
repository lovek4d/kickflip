---
status: superseded in part by ADR-0131
---

# A pending ask or thread message can be deleted or edited, and a pending ask bumped

Superseded in part by [0131](0131-the-cli-and-board-server-do-the-boards-housekeeping.md): the watcher marks an ask or thread message Working as it prints it; `board.mjs working` is gone.

An ask still waiting for Claude has three buttons: bump to top, edit and delete. The owner's message in an item's thread has edit and delete while it is pending: no reply and no Claude line after it.

- **Delete** asks for confirmation, sends an `ask-withdrawn` event `{id}` (`{id, key}` from a thread), then hides the message on the server as in [0008](0008-dismissals-hide-on-the-server.md), so it leaves the thread too. The event wakes the owning session. The session skips a withdrawn message it hasn't started, and stops one it has, replying in the terminal with what it had already changed. Asks and thread messages share one delete path in `board/public/app-asks.js`.
- **Edit** swaps the message's text for an editor with Save and Cancel. Save sends an `ask-edited` event `{id, text}` (`{id, key, text}` from a thread), which wakes the owning session. Events stay append-only: the board shows the latest edit's text wherever the message appears, marked "Edited", and its attachments stay as sent. The session uses the new text; if it had started, it adjusts its work to the new text and says what changed. Edit and delete share one path in `board/public/app-asks.js`.
- **Bump** sends an `ask-bump` event `{id}`. The session takes the most recently bumped ask next, ahead of other waiting work. A pending prototype request is bumped the same way, with its own event id ([0015](0015-prototypes-come-on-request.md)), and a work card with `card-bump` ([0019](0019-a-card-that-hasnt-started-can-be-bumped.md)).

Pending asks list in the Waiting for Claude strip in the order the session takes them: bumped asks first, the latest bump on top, then the rest oldest first. The top ask is always the next one taken ([0016](0016-every-ask-is-a-card.md)). Superseded in part by [0047](0047-the-plus-makes-a-new-card.md): the strip is gone, and New cards lead Todo in this order with these buttons.

When the session starts on an ask or a thread message, it runs `board.mjs --site <route> working <eventId>`. The ask reads "Working on it" until its reply lands (round `site-v9`). A thread message reads the same under it until a reply or a later Claude line, and its card shows a "Working on it" line meanwhile (round `site-v10`).

Delete, edit and bump are events rather than server state, so the session learns of them through the watcher it already runs, with nothing new to poll.

The owner asked for both (ask on 2026-10-23), for delete on thread messages too (in an item's thread), and for edit between bump and delete (INT-15's ask).
