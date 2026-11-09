# The orchestrator's messages, replies and transcript text are markdown

Text an agent writes for the owner to read draws as markdown, through BoardUI.markdown (the notes reader's renderer) with the compact styles a question's descriptions use (docs/adr/2026-11-09-1500-a-questions-descriptions-are-markdown-and-its-text-is-one-brief-line.md): headings at body size, tight blocks, refs linked. Any box with class `md` takes those styles, and its blocks, not the text's own newlines, break its lines.

- The orchestrator's thread messages (`thread --text`, who claude) draw as markdown. The owner's own messages, a shared person's, and lines from GitHub or Slack stay as typed: they are phone-typed or someone else's, and a `*` or `-` in them means what it says.
- `reply <eventId>` takes `--text <markdown>` or `--file`, written to data/replies/<eventId>.md, in place of hand-written HTML (`--html` is gone). Rewriting a reply removes an older .html for the same event. Replies written before this, data/replies/<id>.html, still draw as written, and .json ones as before; store.mjs `REPLY_EXTS` lists the three, read in that order.
- A visual (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md) stays an HTML page; only reply text moved.
- View transcript draws Claude's text rows and its final result as markdown; the start line, tool calls and their output stay as written.

Left plain, each one brief line or text the board doesn't own: status lines, Next, manual steps, card and wave titles, a question's own text, move and hub lines, judgment calls, and the hub's permission prompts. Card notes and PR review comments already drew as markdown.

A push carries a reply's or message's first line as written, markdown marks included.
