# A report for the owner goes to a visual, never a local path

A report the owner reads, an audit or a long finding list, belongs on its task as a visual, with a thread line of only a
summary and the link. A path in the session scratchpad (`/private/tmp/claude-…`), `/tmp` or `~/.claude/jobs` is a file
the owner's phone can't open (#1068).

- **Guidance.** SKILL.md says it. The owner's earlier rule ("any complex report should get a visual instead of a long
  thread message") lived only in the orchestrator session's memory.
- **Guard.** `thread` (claude's lines) refuses text naming such a path and points to `visual add` and
  `item brief --kind visual`. It is a hard refusal like the question-id one: a warning gets skimmed. The pattern
  matches the path only at a word start, so `visuals/A1/x.html` and a bare "/tmp folder" pass.
- **Shortcut.** `visual add --file` takes a `.md` report. `board/markdown-page.mjs` draws it with the renderer the
  board's notes use (`public/ui-markdown.js`, loaded in a `vm` with the two helpers it takes from the browser), inside
  one inline stylesheet that follows the light and dark theme. No dependency was added. Visual pages have no shared
  stylesheet (each agent writes its own inline CSS), so the page style is that one sheet, not a reuse.

Only `thread` is guarded; `reply`, `item set` and the other owner-facing text carry the question-id check alone.
