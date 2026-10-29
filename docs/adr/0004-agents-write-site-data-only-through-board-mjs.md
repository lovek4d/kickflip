# Agent sessions write a board's data only through board.mjs

Replies, thread lines, question topics and questions, item status, follow-ups, builder records and uploads are all written by `board/bin/board.mjs` (logic in `board/store.mjs`). It validates every input and writes atomically. The server only reads these files, apart from the page's own events, hides and uploads.

The owner wants the template to become something an agent session drives only through defined endpoints and flows over JSON, with no hand-edited files (round `site-v6`, question v6-client-domain, option B). Hand edits had skipped checks the pages rely on, such as an option label repeating its letter.

A slip a session makes with a command becomes a check in `board.mjs`, not a note in a skill (owner, card INT-97). Each free-text flag in `TEXT_FLAGS` refuses a value that is only a file path, and `--file` refuses a missing file (`checkInputs` in `board/bin/board.mjs`). A new card comes from `item add <wave>/<id>`, which refuses a taken id or an unknown dep, never from editing a wave file. A reply had gone out as a bare file path, and cards added by hand had skipped the checks.
