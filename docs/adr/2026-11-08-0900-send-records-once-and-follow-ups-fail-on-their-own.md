# Send records once, and what follows it fails on its own

A Send appends the owner's answers, then acts on them: resolves a prototype gate, moves the card, writes the notes, stages the card, starts its planner. Once a follow-up threw a `BoardError` (a card's notes file had vanished), the Send answered `400` with an empty body, the page showed "Could not send. Is the host awake?", Send stayed live, and every tap appended every answer again (12 copies of 8 answers).

## Decision

- **Answers count as sent once appended.** Each card's follow-up (gate move, notes, stage, planner launch) runs on its own; a `BoardError` in one posts a thread line on that card, "Your answers were recorded, but <step> failed: <reason>", and the Send still answers `200`.
- **A recorded answer is recorded once.** `store.mjs unrecorded` keeps only the answers whose question is open or requested, the states `ownerQuestion` gives a question that waits for an answer, so a question reopened since its answer takes a new one. A repeated Send of recorded answers appends nothing and answers as sent, for both `owner-answer` and `owner-answers`.
- **A refused request says why.** The server's catch-all answers JSON `{error}` for any `BoardError`, so the page shows the server's reason; its "Is the host awake?" stays for network failures.
- **A missing notes file is made again** at the same path with the card's title and the answers, and a thread line says the old notes were missing. It no longer blocks answers.

## Not here

Making a card's notes file one-to-one, and refusing `item set --notes-file` for a different file, is #387.
