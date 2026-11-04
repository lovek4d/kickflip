# A full plan opens as a page on the site

A work item may name its write-up in `plan`, a Markdown file inside its wave's folder named relative to it (`board.mjs item set <key> --notes-file <file>`, or `--plan`). Its open card then links to it, and the page renders it for the phone, with tables scrolling sideways inside their own box. The thread keeps the short summary. The write-up is now the card's **Notes**, its living understanding, opened from the "Notes ↗" row of its details list at `notes.html?item=<wave>/<id>` ([notes replace the full plan, and a card starts on its own](2026-10-29-1816-notes-replace-the-full-plan-and-cards-start-on-their-own.md)).

- **The server reads only that file.** `GET /api/notes?item=<key>` (or `/api/plan`) serves the item's `plan` only when it is a `.md` file whose real path, links followed, lies inside the wave's folder. An absolute path, `..`, a link out of the folder, another file type or a missing file is a 404. `--notes-file` makes the same checks when it is set, and the server repeats them, since a wave file can be edited by hand. With no `plan`, it serves the item's short `notes` text instead.
- **The page renders a small Markdown subset itself**: headings, paragraphs, lists, bold, inline code, code blocks, links and tables. Raw HTML in the file shows as text.

Plans were long thread messages, or files on the Mac the phone couldn't open.

Considered:
- the full plan as a thread message;
- a link to the file on GitHub, which most plans never reach.

The owner chose the Full plan link and page (round `site-v20`, A; INT-43).
