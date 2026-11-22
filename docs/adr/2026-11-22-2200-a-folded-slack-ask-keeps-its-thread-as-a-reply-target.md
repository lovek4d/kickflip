# A folded Slack ask keeps its thread as a reply target

Folding a Slack-filed ask into another task (`item triage --fold-into`) dropped the ask's card, and every Slack
lookup went through the card (`askCardOf`), so the folded ask's thread was no longer followed or posted to.

A task now keeps every Slack ask folded into it as a reply target. `askTaskOf` resolves an ask to its card or, failing
that, to the task it was folded into (data/ask-links.json).

- A reply naming the folded ask posts to that ask's own thread, not the task's first thread.
- A later message in the folded thread lands on the task, as a first thread's does, and carries its thread
  (`data.slack.thread`), so a reply naming it posts back to that same thread.
- A queued reply records its thread; one with none, such as an older one, goes to the task's own ask's thread.
- The end and wait lines post only to the task's own ask's thread. The fold posts no line of its own in Slack.
- A task-key reply is refused while a folded ask is unanswered, listing it as any other message.

Builds on 2026-11-21-1700-a-replys-route-follows-the-message-it-names.md.
