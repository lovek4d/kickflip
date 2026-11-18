# Tapping a down course resumes it for the next lesson

T-424 left open whether a course's row gets Continue (T-680). The owner, verbatim: "how about just having it continue whenever it is tapped while down?" and "confirmation on tap if down btw". So there is no Continue button.

- **Down.** A course page (a files page under `~/.claude/kickflip/pages`) whose owner session isn't running, or that has none, reads `asleep`, grey, on its row. A board's asleep is the wake's; a course has no watcher, so only the owner's tap brings its session back.
- **Confirm.** Tapping that row asks first, with the browser's own confirm ([confirmations are the browser's own](2026-11-03-0259-confirmations-are-the-browsers-own.md)): "<course>: its session is down. Resume it for the next lesson?". OK posts `/_hub/resume-course {route}`; Cancel leaves the row as it is and opens nothing. A running course opens as before.
- **Resume.** `new-course.mjs resumeCourse` resumes the recorded session in the course's folder (`sessions.mjs resumeSession`, with a prompt for the next lesson in place of a board's rejoin prompt), so /teach remembers the earlier lessons. With no recorded session it starts a fresh `/teach` in the folder, which reads its files to find where the course left off, and records that session as the page's owner. A session that is already live starts nothing.
- **Starting.** The hub holds the route until its session runs; the row reads `starting`, orange, meanwhile, and the page opens once the resume has answered. A failed resume drops the row back to asleep and shows why.

Considered:
- a custom confirm sheet with Resume and Cancel buttons, which the browser-confirm decision rules out; the words are the notes' and the buttons the browser's.
- the page's own URL asking on a direct load: a course's page is files the hub always serves, so only the sidebar row, the owner's tap, asks.
