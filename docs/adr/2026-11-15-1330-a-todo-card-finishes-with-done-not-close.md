# A Todo card finishes with Done, not Close

The Todo card's finish button read Close while an In Review card's read Done, though both run the same action (card-done). Cards the orchestrator marked as waiting on the owner said "Tap Done" while the Todo button said Close, so the words never matched.

The button now reads Done in every lane, and "Tap Close" is gone from Next texts, the thread-line check and CLI messages. The `--close` flags keep their name; they mark a card as waiting on that tap. The confirm text "Close T1? It moves to Done…" still says what the tap does.
