---
status: accepted
---

# The board owns a card's notes file

Amends [notes replace the full plan](2026-10-29-1816-notes-replace-the-full-plan-and-cards-start-on-their-own.md): notes grow by appended sections, not rewrites, and `item set --notes-file` (and `--plan`) are gone. Closes the notes exception in [agents write a board's data only through board.mjs](2026-10-29-1639-agents-write-site-data-only-through-board-mjs.md).

Every card has its own notes file, and `board/store.mjs` is the only code that writes one:

- **The board names it.** `item add` makes `<id>-notes.md` beside the card's wave file (`-2`, `-3`… while that name is on disk), from `--notes-from <draft.md>` verbatim, or `# <title>` then the `--notes` text, or `# <title>` alone. The new card's ticket body is that text. A card with no file gets one on its first write.
- **Every later write is an append.** `item notes <key> --heading "<h>" --file <draft.md>` adds `## <h>` and the draft; `--from <other key>` folds that card's notes in, headed "Folded from <ref> "<title>"" unless `--heading` says otherwise. The board's own writes (the owner's answers, Implement and Reply words) are the same append. Each one takes a lock per card (`hub/locks.mjs` `withFileLock`), writes a temp file and renames it over the notes. A named file that is gone is started again, with a thread line saying so. `item notes` resolves the card's answered questions still waiting on Claude, as `--notes-file` did.
- **A draft can't be a card's notes.** `item notes --file` and `item add --notes-from` refuse a file whose real path is any card's notes file, live, done or archived, naming that card; there is no override. `--from` refuses the card's own key, and two cards that still name one file.
- **The file refuses the shell.** Each notes file is mode 0444, so `cat >` or `cat >>` into it fails; the rename still replaces it. The board-data hook denies Edit and Write on `.md` files under a board's `data/` and its `~/.claude/waves` folders, naming `item notes`. Drafts live anywhere else.
- **Shared names split once.** As the board server starts (`splitSharedNotes`), of the cards naming one file, live or archived, the earliest made keeps it and each later live card gets a copy under its own name, with a thread line; an archived card is never rewritten. The same pass makes every card's notes file read-only. Other stored names stay as they are.
- **Shared context is a link.** Two cards that need each other's context are Related to each other, and the briefs list linked cards with their notes paths.

The briefs (planner step 5, intake triage's filing, fold and card-added steps) and SKILL.md say to write a draft and run `item notes`, once each, in place of the prose rules on naming and appending.

Owner on #371's gh371-notes-guard: "I feel like the notes should be a one-to-one entity that always every work item has its own notes file by default and it's tied to that notes file exclusively. If there are notes that are to be shared, that means that the items should be related, not that they should share the same file. This should not have to be in the skill language, this should be enforced strictly." Then, on #387's gh387-arch: the board owns the notes file.

What it fixes: #341 was filed with `cat > triage-agent-notes.md`, #317's file, overwriting #317's notes; folding them later with `cat f >> f` grew the file to 24.6 GB; #327's planner pointed its card at a temp copy and deleted it, so the next Send's append threw (#371). The board heard about each only after the shell write, since `--notes-file` checked only that the file existed.

Considered (the architecture review on #387):
- keep agent-named files and refuse a taken one at `--notes-file`, with `set -C` (noclobber) in the briefs. Smallest, but the refusal runs after the overwrite, and noclobber is skill wording;
- a folder per card with one file per section, append-only by construction. Every reader changes, and agents still write `data/` from the shell.
