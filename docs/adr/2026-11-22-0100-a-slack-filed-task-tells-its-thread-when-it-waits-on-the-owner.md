# A Slack-filed task tells its thread when it waits on the owner

A task filed from Slack that stops to wait on the owner posts one line to its Slack thread, "🤖 Waiting on owner: <what is needed>", so the person who asked can tell the work has not stalled. The line never names the owner.

The hub's Slack reply poll (`postSlackReplies`) already walks each open Slack-filed task. It now also reads the card as the board draws it (`builtCards`): a card that carries an owner action or waits on the owner is waiting, and the words are its open question's text, else its next step. `data/slack-threads.json` records the words posted per thread (`waits`). The same words post once; a wait that clears (the entry is dropped) and the next one post again. A board-filed task has no Slack thread and posts nothing. The line posts after the task's replies and is not posted once the task is Done.

A failed post is retried each poll without a fault line on the card: unlike a reply, a wait line is not the orchestrator's words, and a missed one is stale by the time it posts.
