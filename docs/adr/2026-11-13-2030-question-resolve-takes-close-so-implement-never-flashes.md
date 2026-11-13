# question resolve takes --close, so Implement never flashes

Card #648 (T-272). On T-116 the orchestrator ran `question resolve`, then `thread --close`. Between the two writes the card had no open question and a settled discussion, so the board showed Tap Implement before it showed Tap Close. The owner chose to resolve and close in one write over making a close answer never read Implement.

## Decision

- `question resolve <id> --note <t>` takes `--close` or `--implement` (not both) for a question on a card. The note goes into the card's thread and the card is marked waiting on the owner's Done or Implement, as `thread --close` or `--implement` does.
- The card is marked waiting before the question resolves, so no state a board reads between the writes lacks the wait. The owner's file and the card's file are separate files, so this is an order, not one atomic write.
- A question with no card (topic not `item:<card>`) refuses with a flag, and stays open. The note is a thread line, so it takes the thread's length limit.
