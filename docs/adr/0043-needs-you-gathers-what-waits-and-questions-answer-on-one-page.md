# Needs you gathers what waits on the owner, and a topic's questions are answered on one page

What waits on the owner is gathered in one place on the board, Needs you, and the owner answers questions in batches rather than one at a time.

- **Needs you sits at the top of the board,** above the lanes, not on a page of its own. It lists each work item waiting on the owner with what it needs, such as a question, a judgement call or a draft on Ready.
- **One line per work item.** An item that waits for several reasons gets one line joining them, each part a link: "B5: A new or edited phone takes its number's do-not-contact mark · 3 questions · Ready on GitHub".
- **The morning push opens it.** The owner's daily digest is one push that opens the board, and Needs you is what it shows. The owner's Slack digest stopped. A separate Today page, tried after `site-v3`, was dropped because it went stale beside Needs you. On a day when nothing waits, the push is skipped ([0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)).
- **A topic's questions are on one long page,** with one Send at the bottom. Send sends only the questions the owner answered, and the rest stay open for another sitting. Claude replies under each answer. A question shows alone only when it is marked `urgent`, meaning it blocks a build or a merge. It still pushes on the normal schedule ([0006](0006-pushes-only-when-something-waits-on-the-owner.md)).
- **Claude resolves a question as it acts.** The reply that finishes what the owner picked resolves the question in the same step (`board.mjs question resolve`), and it moves under Resolved. An answer such as "not yet" stays open, and the morning push raises it again.

The owner chose these in:
- `site-v2` v2-needs, option A, a strip at the top;
- `site-v7` v7-needs-you, option A, one line per item;
- `site-v3` v3-morning, option B, the board only;
- `site-v4` v4-answer-replies, option B, with the note: "Any larger grills should be done in a long-page format… It should only have a single question on the screen if that question is a blocking or urgent question… have a submit button at the bottom. Assume that I can also answer some of them and leave the rest";
- `site-v5` v5-urgent, option B, blockers shown alone but pushed within the schedule;
- `site-v5` v5-auto-resolve, option A, resolve once Claude has acted.

Considered:
- the lanes alone, or a separate Needs you page behind a count in the header (`site-v2` v2-needs B, C);
- questions and drafts on Ready as separate lines (`site-v7` v7-needs-you B);
- a Today page plus a Slack line, or the Slack digest alone (`site-v3` v3-morning A, C);
- one reply per item once all its questions are answered (`site-v4` v4-answer-replies A);
- no question ever urgent (`site-v5` v5-urgent C);
- the owner tapping Done on each replied question, or replied questions staying until their whole topic resolves (`site-v5` v5-auto-resolve B, C).
