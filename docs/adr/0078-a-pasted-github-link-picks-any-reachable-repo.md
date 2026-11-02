---
status: superseded in part by ADR-0110
---

# A pasted GitHub link picks any reachable repo

Superseded in part by [0110](0110-a-clone-uses-ghs-token-over-https.md): the clone is one https clone with gh's token, which needs no fallback for a public repo. Lookup and branches still fall back to anonymous Git.

The owner picked take A of `prototype-repo-paste.html` on hub/INT-188. [0073](0073-a-new-board-chooses-a-repo-and-branch.md)'s list shows only `gh repo list` for the owner and their orgs, so a collaborator's repo or another owner's public repo could not make a board.

- The repo picker's search box, in New board and Board Settings' Repo → Change, also takes a GitHub link (https, `.git`, `git@github.com:`, `ssh://`, or a browser link such as `…/tree/main`) or `owner/name`.
- A listed repo shows highlighted under "Already in your list". Any other shows "Checking…", then one row under "From your link", tagged "Not in your list" and chosen like any other row, or a one-line reason. A plain `owner/name` matching nothing in the list is looked up after a short pause.
- `GET /_hub/repo` checks it with `gh repo view`, else with an anonymous `git ls-remote` for a public repo gh can't see. Branches and the clone fall back to anonymous Git the same way. Nothing that takes a repo requires it to be in the list.
- Other hosts are refused with "Only GitHub repos work here.", since every PR feature keys on a GitHub repo.
