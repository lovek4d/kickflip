---
status: superseded in part by 2026-11-02-1207-a-clone-uses-ghs-token-over-https and 2026-11-02-1850-a-board-can-work-on-any-git-remote
---

# A pasted GitHub link picks any reachable repo

Superseded in part by [a clone uses gh's token over https, and a failed start shows git's real error](2026-11-02-1207-a-clone-uses-ghs-token-over-https.md): the clone is one https clone with gh's token, which needs no fallback for a public repo. Lookup and branches still fall back to anonymous Git.

Superseded in part by [a board can work on any git remote](2026-11-02-1850-a-board-can-work-on-any-git-remote.md): another host's git link is checked with git's own credential and makes a board on that remote, instead of being refused.

The owner picked take A of `prototype-repo-paste.html` on hub/INT-188. [A new board chooses a repo and branch](2026-10-31-1636-a-new-board-chooses-a-repo-and-branch.md)'s list shows only `gh repo list` for the owner and their orgs, so a collaborator's repo or another owner's public repo could not make a board.

- The repo picker's search box, in New board and Board Settings' Repo → Change, also takes a GitHub link (https, `.git`, `git@github.com:`, `ssh://`, or a browser link such as `…/tree/main`) or `owner/name`.
- A listed repo shows highlighted under "Already in your list". Any other shows "Checking…", then one row under "From your link", tagged "Not in your list" and chosen like any other row, or a one-line reason. A plain `owner/name` matching nothing in the list is looked up after a short pause.
- `GET /_hub/repo` checks it with `gh repo view`, else with an anonymous `git ls-remote` for a public repo gh can't see. Branches and the clone fall back to anonymous Git the same way. Nothing that takes a repo requires it to be in the list.
- Other hosts are refused with "Only GitHub repos work here.", since every PR feature keys on a GitHub repo.
