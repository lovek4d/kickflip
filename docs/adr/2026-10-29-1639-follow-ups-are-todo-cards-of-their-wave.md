---
status: superseded by 2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent
---

# Follow-ups are Todo cards of their wave

Superseded by [a follow-up is a work card with a Parent](2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md): a follow-up is now an ordinary work card with a Parent, and the follow-up list, its Build and its commands are gone. Earlier superseded in part by [a board has one ticket source](2026-11-01-1348-a-board-has-one-ticket-source.md): a follow-up's ticket comes from its board's ticket source, not always Linear.

A follow-up, a Linear ticket filed from a wave's `followups`, sits in Todo until it is done, then in Done. It shows a quiet "Follow-up" badge next to its ref chip. There is no Follow-ups lane. Its card keeps the Build button, which sends `build-followup {key}`: Claude replies with a short plan, then builds it as a draft like any other item (round `site-v3`, question v3-followup-start, option A). It can be bumped like any Todo card ([a card that hasn't started, or is running, can be bumped](2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md)). Todo lists it after that lane's work cards unless it is bumped, because its filed date would otherwise put it above planned work that has no activity yet.

A follow-up counts toward its wave. The wave's bar counts a done follow-up as done and an open one as not done. A wave is finished only when every work item and every follow-up is in Done, so an open follow-up reopens a finished wave: the wave leaves its Done fold and returns to the wave filter and the bars ([lists never cut silently](2026-10-29-1639-lists-never-cut-silently.md)).

When Todo holds two or more follow-ups, it offers "Plan a wave from these N follow-ups". The button sends `plan-followups {keys}` with those follow-ups' keys. With a wave filter on, it covers only that wave's follow-ups. Claude groups them into a small wave, with order and shared files, and asks its questions on the board; nothing builds until the owner answers (round `site-v4`, question v4-followup-wave, option A).

The owner asked that "a wave should include its follow ups as if they were todo". With the Follow-ups lane folded shut, the filed tickets were out of sight, and their waves read as finished with work still open.

Considered:
- Follow-ups become Todo cards only in waves that are still open.
- Keep the Follow-ups lane, and count follow-ups only in the wave bars.

The owner chose every wave (owner, question int78-scope, option B). Thread attachments and Shared contact eligibility reopen, with their five PROD tickets in Todo, until a next wave takes them.
