# A reply posts its questions after it, in one command

The owner (T-222) wants a message's questions to land after the message, so the thread reads chronologically. The thread draws the message at its own `ts` and the questions line at the newest question's `asked_at`, so the order was whichever of `reply`/`thread` and `question add` the orchestrator ran first. Nothing enforced it.

- **`reply` and `thread` take `--questions <json>`**, the file `question add --file` takes. The file is checked first (`checkQuestions`, the validation `addQuestions` runs, which writes nothing); then the message is posted, then the questions are added, so their `asked_at` is after the message's `ts`. A bad questions file is refused before the message posts.
- **Refused beside `--implement` and `--close`:** open questions mean the card is not waiting on Implement or Close.
- **`question add` stays** for questions with no message.
- SKILL.md says to post a message's questions with `--questions`, never with a separate `question add`; `reply`'s output and the watcher's message line say so too.
