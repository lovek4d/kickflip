# Readying no longer needs answers copied into the notes

Ready used to refuse a card whose notes left out the id of an answered question (`cards.mjs checkNotesComplete`, from the [headless builders ADR](2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md)). Builders now read the task's thread as context, so the owner's answers already reach them from the thread, and the check forced the copy back into the notes.

Ready now needs only a size and a notes file. The open-question refusal stays, and readying still resolves the answered questions.
