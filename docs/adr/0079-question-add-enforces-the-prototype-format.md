# Question add enforces the prototype format

The owner asked on hub/INT-193 for "the standard prototype format, no parallel prototypes", after agents' pages added their own selectors, views and about boxes, and their takes showed blank on Waiting on you. The format is [0015](0015-prototypes-come-on-request.md)'s and [0048](0048-a-questions-takes-show-inline.md)'s: one `prototype-<topic>.html` page per question, takes switched only through the shared pill, each take rendering alone with `?take=<key>`.

- `board.mjs question add` refuses a question whose url names a `prototype-*.html` page unless the url carries `q=<its id>`, the page is in the site's `public/`, loads `prototype-switcher.js` and calls `PrototypeSwitcher.mount`, and `takes` is an object literal, inline or in one `const`, with a key for every option id.
- The check reads the page's scripts without running them, so takes built at runtime are refused. It does not look for extra selectors or views; SKILL.md forbids them, and every brief for a prototype carries that paragraph.
