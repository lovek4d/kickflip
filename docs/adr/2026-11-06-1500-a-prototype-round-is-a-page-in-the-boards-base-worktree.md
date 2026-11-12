# A prototype round is a page in the board's base prototype worktree

Card #366 (folding in #308). The owner wants every web prototype, in any repo, to run in situ: loaded with the real site's components, helpers and scripts, fully interactive, with buttons for the states that matter, and cheap enough that one served checkout carries many rounds at once.

## Decision

- **One base prototype worktree per board** (gh366-shape): `~/.claude/kickflip/worktrees/<route>-prototypes`, detached at the board's main ref. `board.mjs prototype base` makes it, or moves it to main's tip with a plain checkout so the rounds' untracked pages stay; when a page's edit to a tracked file blocks the move it stays put and says so. It prints its path, whether the build script is there and the listener's path.
- **A round is a page there**, built from the repo's real components fed mock data, and recorded with `prototype add <topic> --served <path> --take K:label … [--state key:label …]`. A served round has no take files; the board's `prototype-<topic>.html` frames `<path>` from the base worktree's serve.
- **Takes and states switch by message** (gh366-switch): the viewer frames `<path>?variant=<K>&state=<key>` once, then posts `{kickflip: 'prototype', take, state}` on each switch. The page loads `shared/prototype-frame.js` and re-renders in place from `KickflipPrototype.on((take, state) => …)`, keeping typed text and scroll. Messages count only from the framing window.
- **Named states live in the viewer's bar** (gh366-states), as a row of chips above the take pager, kept in `?state=`. Only a served round takes `--state`.
- **The hub serves the base worktree** under try key `prototypes` with the board's build script (`hub/try.mjs`), in `try.json`'s own `prototypes` entry, while an open question links a served round, or a viewer asked in the last 30 minutes (gh308-keep): back after a hub restart while a round is open, stopped once neither holds. A served page asks (`POST api/try {key:'prototypes'}`) on load, every 5 minutes while visible and on becoming visible; `start` on a ready, unstopped serve only stamps the visit, and the relay's traffic stamps it too. A page that finds the site it had framed down says "The prototype site had stopped. Starting it again..." and asks at once (t120-stopped-line). The viewer polls `GET /api/try/prototypes`, starts the serve if it is down, shows Starting while it comes up, and on failure the log's tail with Try again (gh308-down); a failed serve waits for Try again.
- **No build script** (gh366-no-build): the prototype planner writes the missing `.kickflip/build` (or `build-<target>`) in the base worktree, uncommitted. With one worktree on main there is no round branch to write it on; a repo's onboarding to-do (#369) is where it gets committed.
- **The render check (#363) for a served round** runs the base worktree's build script itself on a loopback port, so a question is checked before the hub serves anything (gh308-when), and loads every take at the first state and every state on the first take, at phone and desktop width. It refuses on a throw, a console error, a failed load other than the browser's own `/favicon.ico`, or an empty body.
- **Take files stay** for a repo whose app can't be served as a web page.

## Consequences

- The prototype planner's brief (`board/headless.mjs` `plannerBrief`) builds rounds in the base worktree and never writes in the repo's own checkout.
- Rounds don't interfere: each is its own page with its own mock data, so one serve carries all of a board's open rounds.
- Board rules that describe prototypes as take files on the board site need rewording to the base worktree.
