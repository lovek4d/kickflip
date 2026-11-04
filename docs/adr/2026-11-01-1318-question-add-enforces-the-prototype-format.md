---
status: superseded in part by 2026-11-01-1448-the-board-serves-every-prototype-from-one-template
---

# Question add enforces the prototype format

Superseded in part by [the board serves every prototype from one template](2026-11-01-1448-the-board-serves-every-prototype-from-one-template.md): the board serves each recorded prototype from one template, so `question add` checks the record instead of reading the page, and refuses hand-written pages for new questions. One page per question and takes switched only through the shared pill still hold.

The owner asked on hub/INT-193 for "the standard prototype format, no parallel prototypes", after agents' pages added their own selectors, views and about boxes, and their takes showed blank on Waiting on you. The format is [prototypes come only when obviously helpful or on request](2026-10-29-1639-prototypes-come-on-request.md)'s and [a question's takes show inline, and back goes one step](2026-10-29-1639-a-questions-takes-show-inline.md)'s: one `prototype-<topic>.html` page per question, takes switched only through the shared pill, each take rendering alone with `?take=<key>`.

- `board.mjs question add` refuses a question whose url names a `prototype-*.html` page unless the url carries `q=<its id>`, the page is in the site's `public/`, loads `prototype-switcher.js` and calls `PrototypeSwitcher.mount`, and `takes` is an object literal, inline or in one `const`, with a key for every option id.
- The check reads the page's scripts without running them, so takes built at runtime are refused. It does not look for extra selectors or views; SKILL.md forbids them, and every brief for a prototype carries that paragraph.
