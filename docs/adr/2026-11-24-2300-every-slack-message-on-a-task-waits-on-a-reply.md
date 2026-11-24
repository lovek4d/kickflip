# Every Slack message on a task waits on a reply

A teammate's "can you take a look at <PR link>" from Slack became a task. The orchestrator ran a reviewer, asked the
owner which findings to send, needed two Run taps to post the review, and never answered the Slack thread. The owner
(#1174): a Slack ask runs to an answer on its own, and only Implement waits on them. Rather than prompting at chosen
stages, the owner picked the simpler shape: each incoming Slack message is a wait that needs a reply.

- **One wait per Slack message.** The @kickflip ask, an ask folded in, and each Slack reply copied onto the task as a
  message (`domain.mjs` `slackOwed`, from the thread's messages via `slack`) each open a `slack` orchestrator wait:
  "Answer <who> in Slack: reply <eventId>". It lists with the owner's words, ahead of the lanes' waits, re-wakes like
  an unread reply (`REQUEST_KINDS`), holds no transition and asks nothing of the owner. It shows in every open lane,
  In Review included.
- **Only a reply ends it.** A thread line never does: thread lines stay off Slack (ADR 2026-11-16-1700, unchanged).
  `reply <eventId>` posts to the message's Slack thread and ends it. A message that needs no words (a thanks) takes
  `reply <eventId> --no-reply`, recorded on its card as `no_reply {<event id>: when}`, posting nothing. The task's close
  ends every one, as its end line posts to Slack. `reply <file>/<id>` stays refused while one is unanswered by these
  rules.
- **The owner's own Slack message is still the owner's word.** One with no sender name (the owner's) also opens their
  `reply` wait, which a thread line or a relay ends, so it holds `builder done` mid-build as their board message does.
  A teammate's opens the `slack` wait alone and holds no transition.
- **The reply carries the outcome.** The status reaction (ADR 2026-11-23-0010) shows progress, so the reply is the
  answer, the review link or the task filed, not an "on it". Its ✋ now reads on a message still owed its reply while
  the task waits on the owner; a message marked no-reply reads 👀.
- **The thread shows it.** A Slack message reads waiting… or thinking… in its footer until its reply, like the
  owner's own messages, whatever the orchestrator writes after it. Its reply shows in the task's thread as the
  Orchestrator's message with Slack and who it answered in its footer.
- **Reviewing a PR the message names.** `review post <pr> --task <task>` posts a Comment review on any PR the task names
  by link or owner/repo#n (its title, notes, asks or messages), at the head GitHub reads now, as the board's
  `github_login`. It records nothing in `data/reviews.json`, which holds incoming PRs only (attaching the PR as incoming
  or as the card's own was dropped: `incoming.json` is rewritten each poll, and a card's PR is its own work). It prints
  the link for the reply to carry, so the review is not posted to Slack twice.
- A board question on a Slack task already posts "Waiting on owner" to its Slack thread (ADR 2026-11-22-0100), so a
  clarifying question that blocks implementation needs nothing new; any other goes to the Slack thread by the reply.
