# Deleting a New ask reads deleting… on its own row

Card #1071 (T-721). The owner (11/18): "Deleting from new should change status to deleting… instead of making a new
row", then: "Make sure this also deletes the created task if applicable", with one id linking the send, the ask and the
task, and on a task already triaged: "Delete it too, unless a build has started … need to show not deleted with retry
and dismiss like not sent if a build has started, and toast that a build has already started".

Amends [owner taps wait for the host in the outbox](2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md): a
Delete still goes through the outbox, but no longer draws a "Deleted: …" row of its own. Amends
[a new task shows at once in the New strip as sending](2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md):
an unsent New task now has its Delete until its send fails.

## Decision

- **One id from the tap to the task.** The board server stores an ask from the page under the page's send id (the
  outbox's `sendId`) instead of a fresh event id, so the ask's id, its card's `from_ask` and the id a Delete names are
  the same from the tap on. An ask with no send id, or one not shaped as an id, still takes a fresh event id. The task
  key (T-N) and the GitHub number are unchanged.
- **Delete marks the ask's own row.** `ask-withdrawn` stays out of the New strip's unsent rows
  (`app-threads.js unsentAsks`). The ask's row drops its trash and reads, after its time, **deleting…** while the
  Delete sends, **waiting for the host** while it is held, and on a refusal **not deleted** with the Delete's own Retry
  and X (`ui-threads.js deletingLine`). X gives the row its trash back. Once the board has the Delete, the row reads
  deleting… until the board no longer lists the ask as new (`deletingIn`), so the trash never flashes back.
- **Delete works before the board answers.** A New task the board doesn't hold yet has a trash while it sends or waits
  for the host; its Delete names its send id and goes behind it in the outbox. One whose own send failed shows its not
  sent with Retry and X, and its X drops its Delete too.
- **Delete removes the task until its build starts.** `dropAskCard` drops the ask's card at any stage in Todo
  (untriaged, discussing, staged, ready), not only while untriaged. A build has started once the card left Todo, has a
  PR, or any implementer's builder record opened on it (a planner's record is no build). Then the board refuses the
  Delete with "A build has already started on T-N. Block it to stop the build.", records nothing, and the row reads not
  deleted with that toast.

## Left out

The hub's New strip has no Delete: its rows are routed requests, and its outbox (`view-hub.js`) is unchanged.
