# A kickflip clone is reset to origin on every poll and refresh

#484. Main's refresh icon was refused on a GitHub or plain git remote board with a toast ("only a local board pulls"), and the owner asked for refresh to try the pull again and nothing more. They also asked that a checkout kickflip owns be strictly the latest commit on the selected base branch.

- **Which checkouts.** A GitHub or remote board's repo is a clone under `.repos/` that kickflip made (`repos.mjs`). Those are reset: fetch the branch, `git checkout --force -B <branch> origin/<branch>` and `git clean -fd` (`try.mjs` `resetBranch`). A local board's folder, the hub board's included, is the owner's working folder and keeps the fast-forward-only pull (`pullBranch`); it is never reset.
- **Poll and refresh share one path.** `pullMain` runs `resetBranch` for a clone and `pullBranch` for a local folder, so a clone never reports "split from origin" or "local changes". A real failure (no network, no access) is the same try.json `pull {at, error}` and shows as the red refresh icon; the icon now shows on every board with an origin.
- **No toast.** The 409 is gone. Refresh on a clone rebuilds Main through `tick`, which builds from `refs/remotes/origin/<branch>`. Main's own try worktree gets no `git clean`, which would wipe its installed dependencies.
- **Updates** the line in `2026-11-03-1914-a-local-boards-main-pulls-from-origin-on-its-own.md` that only a local board pulls.
