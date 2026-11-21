# A reply's route follows the message it names

Replies to a Slack message post into its Slack thread (ADR 2026-11-16-1700), decided by the event a `reply <eventId>` names. A reply by task key (`reply <file>/<id>`) names no message, so it stayed on the board even when the message it answered came from Slack (#1117). The owner (11/19): base the route on the message actually being answered, not the latest.

- **The route is the named message's.** `reply <eventId>` posts to Slack when that event is the routed ask or a copied Slack reply, and stays on the board when it is the owner's board message. Unchanged.
- **A task-key reply is refused while a Slack message waits.** `asks.mjs` `unansweredOn` lists the task's ask and its messages with no reply file and no plain orchestrator message after them. If any came from Slack, `answerCard` refuses and lists each with its id and source (`Slack · <name>` or `board`). With only board messages waiting, the route is unambiguous, so a task-key reply goes through as before and keeps the existing flows (triage, `--implement`, `--close`) working.
- **Slack messages are marked.** The routed ask carries `via: slack`, its sender and link in the thread, as a copied Slack reply does; `inbox read` says the ask came via Slack and names the reply that posts, and the signal line reads "new ask from <name> via Slack".
