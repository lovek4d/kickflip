---
status: accepted
---

# Plan waves plans from any Todo cards

This supersedes in part [0034](0034-follow-ups-are-todo-cards-of-their-wave.md): its Todo button planned a wave only from follow-ups, and read "Plan a wave from these N follow-ups".

**The button.** Todo's button takes the Show more row style, the `thread-more` class Done and Asks use ([0144](0144-answered-asks-have-their-own-section-below-done.md)), and reads "Plan waves" (owner, gh97-copy), with no count. It shows when Todo holds two or more work cards or follow-ups that nothing holds or blocks; New cards are not counted (`BoardUI.planButton`). Waves are triage of any Todo cards, not only follow-ups (owner, #97 and #90).

**The event.** It is renamed `plan-waves {keys}`, with the keys of those cards. The session triages them into one or more waves ([0109](0109-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md)) and asks the owner to confirm each as a question on the board; nothing builds until the owner answers.

The wave filter no longer narrows the button: it covers every free Todo card shown.
