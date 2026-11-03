---
status: superseded in part by ADR-0143
---

# A page joins without a session

Superseded in part by [0143](0143-kickflip-join-adds-the-current-repository-as-a-board.md): a join names its site with `--name "<name>"`, which gives its title and route, in place of the route argument and `--title`, and a plain page's rejoin passes `--port`, `--dir` or `--cmd` again.

Any session can put a page on the hub with one command and no machinery. The owner picked join-shape A on hub/INT-201: `kickflip join <route> --port <n>` or `--dir <folder>`, with no session id, makes a **plain page**, and `--watch` with `--session` opts in to what every join did before. A page that only wants to be seen, such as a course or a tool, had to record an owner, run and relaunch a watcher, write needs.json and follow the handover rules.

- **Shape.** A plain page's manifest entry has no `owner`, `watch` or `filter`. With `port` and no `cmd` it is a server its session runs; with `dir` and no `port` the hub serves the folder's files itself (`hub/files.mjs`); with `cmd` the hub runs it, as before. `hub/hub.mjs` `servesOf` reads which, and the hub's status rows carry it as `serves`.
- **Down.** The hub probes a `port` page every 2 seconds and never starts or restarts it, so it reads Down while nothing answers, and its down page says the session runs that server. A `dir` page reads Down only while its folder is missing.
- **Files.** The hub strips `/<route>`, serves a folder's `index.html`, redirects a folder asked for without its trailing slash, and refuses any path with a part starting with `.`, so a project folder's `.git` or `.env` stays on the Mac. Files are read on each request with `no-store`, so an edit is live on the next load.
- **Nothing to answer.** The hub never asks a site without an owner for `GET /_claude/needs`, so a plain page has no Needs you badge and adds nothing to the Home Screen badge. No watcher, wake, resume or push covers it, since none of them reaches a site that isn't a board or has no owner.
- **App shell.** A plain page is a site like any other to the shell: it shows under Pages, a page load gets the shell and the page loads in its frame ([0055](0055-one-app-for-the-whole-hub.md)).
- **Ownership.** A plain join refuses a route a session owns, exit 3, and never takes one over. `kickflip leave <route>` takes a plain page off with no `--session`, keeping its files.
- **Unchanged.** A join with `--session` behaves as before, with or without `--watch`, so boards, `start`, `resume`, the hub's rejoin prompts and /learn keep working. `--watch` with files still names the files to watch.

Considered:
- a separate command, such as `kickflip page`, which would leave two ways to put a site on the hub;
- giving every plain page a starter server for the hub to run, which keeps a process per page where the hub can serve files itself;
- keeping the owner record optional but still fetching needs, which would ask every dev server for `/_claude/needs` every 20 seconds.
