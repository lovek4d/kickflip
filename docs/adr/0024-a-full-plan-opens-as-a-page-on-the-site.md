# A full plan opens as a page on the site

A work item may name its full write-up in `plan`, a Markdown file inside its wave's folder named relative to it (`board.mjs item set <key> --plan <file>`). Its open card then shows a **Full plan** link, which opens `plan.html?item=<wave>/<id>`: the write-up rendered for the phone, with tables scrolling sideways inside their own box. The thread keeps the short summary.

- **The server reads only that file.** `GET /api/plan?item=<key>` serves the item's `plan` only when it is a `.md` file whose real path, links followed, lies inside the wave's folder. An absolute path, `..`, a link out of the folder, another file type or a missing file is a 404. `--plan` makes the same checks when it is set, and the server repeats them, since a wave file can be edited by hand.
- **The page renders a small Markdown subset itself**: headings, paragraphs, lists, bold, inline code, code blocks, links and tables. Raw HTML in the file shows as text.

Plans were long thread messages, or files on the Mac the phone couldn't open.

Considered:
- the full plan as a thread message;
- a link to the file on GitHub, which most plans never reach.

The owner chose the Full plan link and page (round `site-v20`, A; INT-43).
