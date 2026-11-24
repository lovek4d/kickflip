# Linking two cards posts a keyed line in both threads

A link between two cards used to show only in the Related section higher up in the card, so a comment that became its own card left no mark in the thread it came from. Now every link change posts a keyed status line (`command`, per [a button without a text box posts a keyed status line](2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md)) in both threads, in order, so the thread has a chronology.

- `store.mjs` `changeItem` and `createItem` compare the card's links (`linksOf`: Related to whichever card stores it, and its Parent) before and after the write, and `postLinkLines` posts a line for each difference: `related` "Related to", `unrelated` "Unrelated from", and for a new Parent `followup` "Follow-up" in the Parent's thread and `followup-of` "Follow-up of" in the child's. A link already there posts nothing. `relate-ask` keeps its Moved lines; `moveQuestions` relates through `setItem`, so it posts.
- The line stores the other card's key in `card`, not its ref or title. A new card's ref changes when its GitHub ticket exists and titles are renamed, so `domain.mjs` `threadOf` draws "Related to #N: <title>" and the link to the card when the thread renders.
- One link icon covers all four words (the owner's pick of the prototype round), each with its `MARK_ICONS` entry for the every-line-has-an-icon test. They are quiet lines: never unread, and not an answer from Claude.

## A card filed from another reads Filed, not Related to

A task the orchestrator files (`item add --ask`) has one filed-from card: `--from`, else its first `--relate` unless it has a `--parent`, whose Created ticket and Created from lines already tell it (`domain.mjs` `filedFromOf`). `--from` links the two cards even with no `--relate`.

- That card's thread reads `filed` "Filed <child>" in blue with the arrow mark, in place of Related to; the child's own "Filed from <card>" is drawn from its ask. Both name the card as every keyed line does, so the ref shown is the one the card has when the line shows, not the one stored with the ask. A New child holds the parent's line until it leaves New (`postHeldLinks`), as it did Related to. Other related cards keep Related to.
- A builder's or planner's "From <ref>'s builder" resolves its ref the same way.
- Lines already stored in older threads stay as they were.
