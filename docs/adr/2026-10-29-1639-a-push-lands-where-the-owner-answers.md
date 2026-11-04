---
status: superseded in part by 2026-10-30-1125-back-follows-the-page-tree
---

# A push lands where the owner answers

Superseded in part by [Back follows the page tree](2026-10-30-1125-back-follows-the-page-tree.md): `from=push` no longer sends the back arrow of Waiting on you or a prototype page to the card or the board. A push to either builds the board and Waiting on you under it, and back goes up a level. The forward to the card's thread below still holds.

A tap on a push opens the place the owner acts on it, at the moment they tap, not where it pointed when it was written.

- **A card or ask push opens its thread at the reply box.** `board.mjs push`, and every push a board writes (`store.mjs pushUrl`), turns `#item=<key>` into `#item=<key>&reply`. The board opens the card, waits briefly for its thread to load, then brings the reply box into view and focuses it. iOS shows no keyboard for a focus no tap started, so one tap on the box then types.
- **A queued push follows the thread.** When a Claude thread line or reply rewrites a queued push's body ([pushes go out by kind, and each arrives on its own](2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md)), its url becomes that thread's reply link too, whatever page it first linked. A re-push after one has gone also opens the thread, not the sent push's url.
- **A prototype push forwards once its question is picked.** A push to any page other than the board gains `from=push`, which also sends that page's back arrow to the card or the board ([a question's takes show inline, and back goes one step](2026-10-29-1639-a-questions-takes-show-inline.md)), and a prototype page with `?q=<question id>` acts on it. On its first load, if that question already has a pick, the page replaces itself with the question's card thread (`item:<key>`), or with `questions.html` for a declared topic. The page drops `from=push` from its URL, so a pick made on it, or a reload, stays put. Opened from the card's pill, the prototype always shows, with Picked or Change pick.

The owner asked for this after a "Pick a landscape layout" push, rewritten by the later "Picked A…" thread line, still opened the prototype they had already picked from (`shipyard-orchestrator`, 2026-10-23): "Push notifications should be intentional when linking to prototype, if prototype has already been selected go to thread instead. Generally response pushes should focus the response box on the thread as well."
