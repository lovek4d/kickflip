# A card's Questions button opens the questions sheet in place

The card's Questions button was a plain link to `questions.html#<first question>`, so a tap navigated to Waiting on you while the sheet opened over it. It now carries `data-questions` like a thread's "N questions added" line, so the board's one click handler (app-questions-sheet.js) opens that topic's sheet over the board and keeps the tap from navigating. The href stays as the fallback for a topic with no open question, where the link marks its row on the page.

Every in-app entry to a topic's questions (card button, thread line, Waiting on you row, a question link) opens the same `BoardQuestionsSheet`; a push still lands on the page by URL. The sheet stays its own dialog rather than `#readerSheet`: it holds a form with drafts and a Send, which the reader's read-only body has no place for, and it already shares the reader's shape and classes.
