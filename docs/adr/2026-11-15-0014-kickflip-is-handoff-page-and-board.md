# /kickflip is handoff, page and board

Before, the skill answered `/kickflip <route>` (serve or take over a site) and `/kickflip --name '<Board name>' …` (join a board as its session, which the hub also sent to start a board's session), and its description also covered plain page joins and phone pushes. A session that wanted to send its work to a board had no form at all.

The owner, verbatim: "How about /kickflip handoff <board name, optional> to send in a task to that board, /kickflip page <route> for a non board page like learn, /kickflip board <route> to create a board with the current session as orchestrator. And align the CLI accordingly, and simplify the skill entry points to that?"

The skill's entry points are exactly three, each a `kickflip` command of the same name:

- **`kickflip board <name> --session <id>`** is `join --template board --watch`. A new board starts on its own cards, `data/items.json`, as New board does; a rejoin passes no items, so its `board.json` keeps the ones it names (a board over `waves` stays one). A route a page holds is refused rather than turned into a board.
- **`kickflip page <name>`** is `join` for a site that isn't a board: a plain page with `--port`, `--dir` or `--cmd`, or with `--session` one the session answers, with `--watch`. It refuses a call with neither, since a bare `join` adds the cwd's repo as a board, and refuses `--template` and a route a board holds.
- **`kickflip handoff [<route>] --text|--file`** files the session's objective as an `ask` on that board, which becomes a New task there like any ask. With no route it goes on the router's queue (`router.mjs queueRequest`), and the hub's 15-second tick routes it: the CLI never drains the queue itself, since the hub's drain could take the same request in parallel and file it twice.

`board` and `page` take the name as their one word, which `join` reads as `--name`: a route, or a name such as "Bob's board" whose route is the name hyphenated, which the hub's prompts need to keep a board's title. `join` stays as the plumbing all of them call, and the CLI's other commands are unchanged.

**The hub sends `/kickflip board '<name>'`** to start every board's session, to resume one, and to start or resume the hub board's (owner: "The hub runs /kickflip board <route> too"), so there is one entry point for making and rejoining a board. A resume's prompt adds the reason and the session id on the line under it, and no longer names the CLI's path, which the skill's `$KF` gives. New board's and `kickflip join`'s prompts drop `--template board --items data/items.json`, which `board` implies.

**A session's handoff has no source ticket**, so it doesn't carry T-259's `from` (`board.mjs handoff`, [handoff moves a ticket to another board and leaves a pointer](2026-11-14-2340-handoff-moves-a-ticket-to-another-board-and-leaves-a-pointer.md)), which names a board and a card. It carries the router's `routed {reason, via, by, at}` instead, on both paths, with `via: handoff`: the thread opens "Routed here from a handoff: <label> named this board" for a named board, or the router's reason when it picked. A board's orchestrator handing one of its own tickets still uses `board.mjs handoff`. Only router-picked requests land in the Hub page's Routed section.

**The old forms are gone, with no hint** (owner: "Don't worry about hints, no muscle memory yet"). The phone push is the CLI's alone (`kickflip push`, `board.mjs push`), out of the skill's entry points; its reference stays in SKILL.md.
