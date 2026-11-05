---
status: accepted
---

# A hook refuses hand edits to board data files

`hooks-plugin/hooks/board-data-gate.mjs` is a PreToolUse hook on `Edit|Write`. On a board site (a manifest site whose command runs `board/server.mjs`) it denies a write to `board.json`, to any `.json` under `data/`, and to the wave file `board.json`'s `items` names (`data/wave.json`, or `~/.claude/waves/*/wave.json` when `items` is `waves`). The reason names the `board.mjs` command that does the job.

Decided with the owner on #235:
- **Deny, with no bypass.** A fix `board.mjs` can't make becomes a `board.mjs` command.
- **Edit and Write only.** Bash writes are not caught.
- **Question drafts live in `<site>/drafts/`**, outside `data/`, so agents keep editing them freely before `question add --file`. The hook covers only the files `board.mjs` owns; nothing the orchestrator could do before is lost.
- Notes `.md` files, plain `--watch` pages and the hub's own `manifest.json` and settings stay writable.

Draft files already in a site's `data/` are board data to the hook now; move them to `drafts/`.
