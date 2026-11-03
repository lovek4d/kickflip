# A building card opens its worktree in VS Code, on the host only

A work card whose builder keeps a worktree shows **Open in VS Code** on its Links line, after Notes, when the page runs in a browser on the hub's own machine. The link is `vscode://file/<absolute worktree path>`, which VS Code opens as a folder on the machine whose browser follows it (`board/public/app-cards.js`).

- **Which cards.** `/api/board` gives each work card `worktree`: the path its newest builder record keeping one names (`board/domain.mjs` `worktreeOf`), or null once that folder is gone, as after land removes it (`board/server.mjs` `board`). A card with no worktree shows no link.
- **Which browsers.** `/api/board` answers `onHost` per request (`board/on-host.mjs` `fromHost`). Every tailnet request reaches the hub from 127.0.0.1 through `tailscale serve`, which puts the client's tailnet address last in `X-Forwarded-For`, and the hub passes that header through to the board server. The request is from the host when that address is one of the machine's own interface addresses (`os.networkInterfaces`), or, with no such header, when it reached the hub straight on loopback. A phone or another machine gets no link.
- **Paths are absolute.** Builder records store the worktree's absolute path (`board/worktree.mjs` `makeWorktree`), so the link needs no `~` expansion.

The owner (ask, 2026-11-03): "it would be cool if on the host machine you could click a link on a given work item that takes you to that work tree ... maybe like a VS Code integration that just opens that branch in VS Code". Settled in the grill: only cards with a worktree, VS Code only, the link only on the host, detected from the request. In the placement prototype (gh112-placement, take A) the owner picked the Links line and said "Drop the copy CD."

Considered:
- a copied `cd <path>` command beside the link: dropped by the owner in the prototype;
- Remote-SSH links (`vscode://vscode-remote/ssh-remote+<host>/<path>`) for other machines: the owner wants the link on the host only;
- telling the host apart by `Tailscale-User-Login`: the owner's phone and Mac sign in as the same user, so it can't;
- the Host header: every tailnet device asks for the same tailnet name.
