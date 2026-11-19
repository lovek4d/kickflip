# A take pick owes a final visual, and its confirm is Implement

A final check on a visual was asked as a "does it look right?" question on T-736 and T-739 because the orchestrator
wrote the visual brief without `--final`. The owner's rule: any final check uses the card's Implement as its mechanism.

Decision: the visual owed after a take pick is final on its own (the owed entry carries `final`, and `item brief`
copies it onto the brief). The brief wait's text and `item brief`'s output name `--final`/final. `visual add
--implement` marks its thread line, and `question add` refuses a question on a card whose newest visual line is so
marked while Implement is still its mark: the owner's tap is the confirm, a thread message the change.
