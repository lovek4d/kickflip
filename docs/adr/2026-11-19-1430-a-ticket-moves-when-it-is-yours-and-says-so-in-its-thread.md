# A ticket moves when it is yours, and says so in its thread

Amends [kickflip reaches Linear with a key on the Mac](2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md)'s
assignee rule. The owner's Done on T-552 left GitHub #674 open with nothing in the thread: the issue had no assignee,
and `moveTicket`'s "left as it is, not assigned to you" went only to the tap's HTTP response. The owner settled it on
T-566: "only auto move tickets assigned to self, although tickets should be assigned to self automatically when going
into in progress or when created by kickflip", one flow for GitHub and Linear, a line for every outcome, and a reopened
task leaves its issue closed.

- **One rule for GitHub and Linear.** A card's ticket moves (start, review, done) only when it is the owner's: assigned
  to the owner (the Linear key's viewer, or `gh`'s user), or created by kickflip (the card's `ticket_created`). A
  ticket assigned to someone else is left as it is.
- **The owner's from creation.** A ticket kickflip makes is assigned to the owner as it is made (`gh issue create
  --assignee @me`, Linear's `assigneeId`), so `ticket_created` reads true to the issue too.
- **The owner's from the start.** A build's start assigns an unassigned linked ticket to the owner (`gh issue edit
  --add-assignee @me`, Linear's `issueUpdate`) and moves it from then on. At review or done, an unassigned ticket
  stays as it is and writes no line: the owner, on T-566, "Let's just not worry about reporting an unassigned close
  skip"; T-780's comment on the ticket covers it.
- **A line for each outcome.** `moveTicket` returns a status line kind and `changeItem` writes it in the card's
  thread, where the CLI prints it too: `ticket-assigned` (a GitHub start, which has no In Progress), `ticket-moved`
  (Linear's In Progress and In Review, naming an assignment it made), `ticket-closed`, `ticket-left` (assigned to
  someone else), and `ticket-failed`, a fault, with why (no repo, no Linear key, gh or Linear refusing).
- **One way.** A closed or completed ticket never reopens, and a move that changes nothing writes nothing, so a task
  reopened from Done leaves its issue closed.

The hub's Linear poll (`hub/github.mjs` `advanceLinear`) keeps its own copy of the assignee rule until the ticket
seam (T-781) routes it through `moveTicket`'s policy.
