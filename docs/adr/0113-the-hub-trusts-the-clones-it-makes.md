---
status: superseded in part by ADR-0127
---

# The hub trusts the clones it makes

Superseded in part by [0127](0127-a-board-can-work-on-any-git-remote.md): a clone of another host's repo is `<host>/<path…>` under the same folder, with no clone above it, and is marked the same way.

hub/INT-252 found that the dev-setup board didn't start: `claude --bg` in `.repos/ever-cars/dev-setup` failed with "Workspace not trusted". Claude Code keys workspace trust on the git repo root. A folder's trust covers its subfolders but not a git repo nested inside them, so trusting `~/dev` doesn't cover a clone under `.repos`. No flag, setting or environment variable accepts trust for `--bg`: `-p` skips the dialog but can't be combined with `--bg`. The Claude Code docs (permissions, "Project allow rules and workspace trust") give one fix: set `projects["<repo root>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`, or in `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set. The owner picked this (take A of `new-board-trust`).

- **The New board tap is the consent.** The owner's New board tap accepts Claude Code's workspace trust for the clone that the hub makes for that board. The hub then marks the clone trusted before it starts the session.
- **Only the hub's own clones.** `startSession` (`hub/sessions.mjs`) marks a folder only when its realpath is `<owner>/<repo>` with its own `.git` directly under the folder that the hub clones into (`isClone` in `hub/repos.mjs`, `reposDir` in `shared/repos.mjs`). `kickflip start` uses the same check, so a retried start in a clone gets the mark again. The hub never marks a folder outside that folder, whatever `--repo` names.
- **How it writes.** `trustFolder` (`hub/trust.mjs`) keys the mark on the clone's realpath, the repo root that Claude Code checks. It changes only that project's `hasTrustDialogAccepted` and keeps every other key. It writes a temp file beside the config's real path with the same mode, then renames it into place. Claude Code rewrites the file from memory, so the hub reads it again after the write and writes once more if the mark is gone.
- **It never creates or repairs Claude's config.** If the file is missing or isn't a JSON object, the hub writes nothing. The start then fails, and Didn't start reads "Couldn't trust this folder for Claude Code:" with the reason. A mark lost on both writes fails the same way.

Considered: a Trust this folder step on the Didn't start row, with a command to copy and a Retry, so that nothing writes to Claude's config (take B). The owner chose A.
