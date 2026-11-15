# A new task's thread starts with the owner's message alone

The owner on hub/T-437: "Drop the triaged message on landing the ticket. When it's landed for the first time after ingestion, it's fine if mine is the only message there. and it can have the thinking status on it until there's an actual answer." Amends [a new task is triaged in one command before it is investigated](2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md).

- **Item triage posts no thread line.** `triageItem` sets the title, phase and links and records `triaged: {at, phase}` on the card; that sorts the card and ends its intake wait. The title, phase and links show on the card. The owner's message stays alone in the thread and reads thinking through the investigate wait, until the orchestrator's first real line. `--fold-into` still posts its "Triaged: folded in …" line, on the target card, where the owner's message went.
- **`--text` goes only with `--fold-into`.** On a plain triage it is refused: what the orchestrator knows goes in the notes (`item notes`), not a thread line. Refusing beats a flag that quietly writes somewhere the owner doesn't look.
- **The "Triaged:" exemption in the investigate wait stays** (`domain.mjs` `waitFactsOf`), for threads written before this change: their line is later than `triaged.at` and would otherwise end the wait as a reply.

## Thinking only while the session works

The owner: "My message could also lose the thinking status if you're not actually thinking on it. It could go back to waiting."

Audit before the change: an owner's message read thinking when the board was listening (`listenState`) and the watcher had marked the event working (`data/working.json`), until a reply or a later orchestrator line. Listening means the session runs and a watcher runs, or the session is busy since the watcher exited. A session idle with its watcher relaunched read listening, so a message nobody was working on read thinking until the next reply. The footer followed listening, not the session's busy or idle.

Now `hub/boards.mjs` `sessionBusy` reads the owner session's record (`~/.claude/sessions`, `status: busy`, as `watcherRunning` does). The thread's `listening` (`server.mjs`) and `withHub`'s `busy` (a card's and a New ask's working state) require it: an idle session reads waiting, a busy one thinking. Tests: `hub/boards.test.mjs` pins `sessionBusy`, `board-asks.test.mjs` pins `withHub`, and `domain.test.mjs` already pins that a thread not listening reads waiting.

`status` is an undocumented Claude Code field. A record that never says busy reads every message waiting, which is the safe side: the wait list and pulls are untouched, as thinking is display only ([every wait is listed and working is display-only](2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md)).
