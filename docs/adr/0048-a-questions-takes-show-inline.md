---
status: superseded in part by ADR-0055 and ADR-0058
---

# A question's takes show inline, and back goes one step

Superseded in part by [0055](0055-one-app-for-the-whole-hub.md) on how back finds the step: in the app shell the referrer stops changing, so each history entry carries `{idx}`, and the arrow goes back while `idx` is above 0. A page a push opened still goes to its `backHref`.

Superseded in part by [0058](0058-back-follows-the-page-tree.md) on back from Waiting on you and a prototype page: in the app it goes up a level, from a prototype to Waiting on you on its question and from there to the board, however the owner arrived, a push included. Every other page still goes one step back.

A question's takes show on the questions page itself, not behind a link. Every page opens in the same window, and its back arrow goes one step back.

- **Takes inline, in a grid.** On `questions.html` a question's takes sit in a grid that fits as many columns as keep each take at least 380px wide: one column on a phone, two on a wide screen's question. Each take shows its option (pick, label, detail) above its preview, and the takes in a row align to the top. Each take has its pick there, and the question keeps its note and the page's one Send ([0043](0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)).
- **A framed take fits its page.** A frame doesn't scroll, so it takes its page's own height at its column's width, measured once the page loads and again as it grows or the view's width changes; it shows "Loading take…" until then, so nothing cut off flashes. A take whose page is taller than 80% of the screen shows a full-width "Open full size →" button saying it scrolls, in place of its frame. At `?take=` `prototype-switcher.js` trims the bottom padding a page keeps clear for its pill, so the frame ends where the take does.
- **What a take shows comes from the question.** A question whose `url` is a prototype page already says each option is one of that page's takes ([0015](0015-prototypes-come-on-request.md)), so it needs no new field. Each option then shows the page in a frame at `?take=<option id>`, where `prototype-switcher.js` shows that take alone, with no header or pill. An option with nothing to see carries `diagram`, rows of up to four boxes `{text, tone?, to?}` coloured by the status colours, and `practice`, a line or two of what it means in practice. The page draws them as boxes and SVG arrows that wrap at any width. `board.mjs question add` checks both fields. A question whose takes show in frames drops its "See the prototypes →" pill; one drawn as diagrams keeps it.
- **Full size is a page in the same window.** A take's "Open full size →", under its frame or as its button, opens the prototype page at `?variant=<option id>`. A link to a page on the hub opens in place everywhere on the board, in thread lines, replies and questions; only another origin opens a new window.
- **Back goes one step.** Every page header with a back arrow (`ui-page-header.js`) goes one step back in history when the page before was on the hub. When a push opened the page, or nothing came before it, the arrow goes to its `backHref`, the work item or the board. `store.mjs pushUrl` marks every push to a page other than the board with `from=push`. The header keeps that mark in `sessionStorage` for the page's reloads, since the prototype page drops it from its URL ([0036](0036-a-push-lands-where-the-owner-answers.md)).
- **Prototype pages share the board header**, `<!--header {"lead":"back","backHref":"./#item=<wave>%2F<id>","title":"…","controls":false}-->`. The back arrow stays at the left, in the bottom bar below 900px ([0070](0070-phone-headers-sit-at-the-bottom.md)) and at the top on desktop.
- **A pick on a prototype page sends at once.** Pick this has no confirmation, and a later pick changes it. A note box above the pill goes with it, and Cmd/Ctrl+Enter in it sends. The page then uses `BoardUI.nextQuestion` in `ui-questions.js`, the same pure move-on rule as Send on Waiting on you ([0038](0038-waiting-on-you-leads-with-what-needs-the-owner.md)), and opens the returned question’s prototype page, or its card on `questions.html`. When it returns null, the pick leaves `BoardUI.sentNotice` under the board’s route and goes to the board, whose Sent toast says what it sent. Framed in the app shell, the pick uses the top window’s `BoardUI`, which owns that notice. Opened alone, the switcher loads `ui.js`, `ui-links.js` and `ui-questions.js` if needed, so prototype pages need only their existing scripts.

The owner asked on INT-104: "Prototypes should not spawn in a new window, and back should not link all the way back to the task; back should go back in nav one step. If a prototype was opened from a push notification, only then should back become back to work item. Also prototypes should share the header with the rest. Even better, prototypes should be shown inline with the grill page, instead of a regular multiple choice." From its prototypes they chose:
- `pi-layout` carousel: one take at a time with the next peeking, side by side on a wide screen. On INT-150 they found side by side cramped and asked to stack the takes, with a take that scrolls going straight to full size, and picked `takes-stack` fit: each frame sized to its page. They then asked for a grid where takes fit side by side, so a wide screen shows more than one per row;
- `pi-open` page: full size opens as a page in the same window, and back goes one step;
- `pi-diagram` svg: boxes and arrows drawn to fit, coloured by meaning, with what the take means in practice.

While it was built, they added a pick with no confirmation, a note with the pick, and moving on to the next open question after one.

Considered:
- the option list with each preview opening under its option (`pi-layout` expand);
- stacked frames of a fixed height, a take that scrolls showing the button or its top fading out under Open full size (`takes-stack` link, peek);
- full size as a sheet over the questions page, or no full size at all (`pi-open` sheet, inline);
- a take with nothing to see as numbered steps, or as a text diagram that scrolls sideways on a phone (`pi-diagram` steps, ascii);
- a per-option `preview` url, which repeats the question's own prototype page on every option.
