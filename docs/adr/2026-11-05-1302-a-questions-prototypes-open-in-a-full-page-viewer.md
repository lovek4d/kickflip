---
status: accepted
---

# A question's prototypes open in a full-page viewer

Supersedes in part [a question's takes show inline, and back goes one step](2026-10-29-1639-a-questions-takes-show-inline.md): its two layouts, the frame measuring, `?take=`, and a pick on a prototype page sending at once. Its diagrams, its back rules and its shared header stand.

A question whose `url` is a prototype page shows plain options and one **View prototypes** button, which opens the prototype page: the full-page viewer, one take at a time. Nothing is framed in the question, so a take is no longer squeezed into a frame on Waiting on you, and a prototype can be as big as the page it is a rough pass of.

- **Waiting on you frames no take.** The question shows its options as radios, as any question does, with View prototypes above them, the same button the phone's deck already shows (`app-needs.js`). An option with `diagram` still draws its boxes and `practice` in the question. A confirm round shows the same button, which opens the viewer on its one take with `?variant=`; its own Open the prototype link is gone. `view-questions.js` drops the frame measuring, the grid and full-width layouts and the in-place switch; `prototype-switcher.js` drops `?take=`, the take shown alone for a frame, and `PrototypeSwitcher.current`.
- **The viewer is the prototype page.** It keeps its header, whose back arrow goes up to the question (router.js page tree), and its floating ‹ take › pill; ←/→ switch takes.
- **A switch keeps the scroll position.** The kit already held the page's scroll across a switch; it now also scrolls each box inside the take back to where it was, matching a box in the new take by the tags and classes from the stage down to it, counted where several share them. A box the new take draws elsewhere starts at its top.
- **Pick drafts and goes back.** Pick this (Change pick once another take is the pick) writes the take, with the note typed above the pill, into the `{choice, note}` draft Waiting on you keeps for that question, and goes back to the question, where Send sends it with the rest of the topic. The pill reads Picked on the pick Waiting on you shows: the draft, else the last answer, else the suggested option. A resolved question, and one waiting on the prototype the owner asked for, show their locked pick and offer none, since Waiting on you would not send it. The switcher no longer loads the board's question helpers or moves on to the next question itself.

The owner chose take B of `gh278-look-3` on #278, a full-page viewer that keeps the scroll position on a switch: "this is good, gives room to build out real prototypes without the constraint of in page viewing". Its earlier rounds asked for takes served as running worktrees of the real app ("give me a true in situ"), then for "switching between options replaces a single view of the prototype, rather than side by side options", and "it should not reset the scroll position when changing between them". Prototypes that are ready the moment the question shows, with no step to open them, are #308.

Considered:
- tabs over one view inside the question, with ⤢ Full page lifting it out (round 2 and 3 take A, recommended);
- the options as the switcher, tapping one swapping a single view beside it (take C);
- served worktrees per take, opened from a hub start link, with a start page or a sheet (round 1), left for #308;
- a ✕ and swipe on the viewer's pill, as drawn: the header's back arrow already returns to the question, and swipe is left to #287.
