# A task's PR or landed commit is commented on its ticket

The owner's rule (T-566, question 9): when a task's PR opens, or its commit
lands on main with no PR, kickflip always leaves a comment on the task's
ticket, whoever the ticket is assigned to. For an unassigned ticket that
comment is the whole sign. Most boards land straight to main, so the landed
form is the one that fires for them.

- One comment per PR or per land. The finish that opens the draft PR writes
  `PR opened: [<PR title>](<PR url>)` (finish.mjs sendForReview). The land that
  pushes main to origin writes `Landed on main: [<commit subject>](<commit url>)`
  (finish.mjs pushBase), on a board with a GitHub repo, once the push succeeded.
  A push to a PR that is already open, a finish that finds the branch's PR already
  there, and a land whose push is off or fails comment nothing.
- A GitHub issue comment (`gh issue comment`) or a Linear comment
  (`commentCreate`), by tickets.mjs commentTicket.
- The card's thread says so: `ticket-commented` ("Commented on #7."), or
  `ticket-failed` ("Couldn't comment on #7: <why>") when the call fails. A failed
  comment never stops the PR, the land or the hand-back.
- Unlike a ticket's move ([a ticket moves when it is yours](2026-11-19-1430-a-ticket-moves-when-it-is-yours-and-says-so-in-its-thread.md)),
  the comment does not look at the assignee.
- A board with no GitHub repo has no commit URL to link, so its land comments nothing.
