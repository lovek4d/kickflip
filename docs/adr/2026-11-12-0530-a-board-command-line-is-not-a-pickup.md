# A board command line is not the orchestrator's pickup

A wait on the orchestrator reads as picked up once the session writes on the card (`waitFactsOf` in board/domain.mjs).
The board itself writes claude thread lines carrying a `command` (staged on an Implement or Reply tap, related, followup
and followup-of on both cards of a relation, readied). Counted as the session's writes, they made a staging wait read
picked up within milliseconds, so `waitsStep` added no wake for it, and relating a card to a waiting one faked a pickup there.

No line with a `command` is a session write. The session's pickups stay: its own thread lines, replies, verifies and
builder starts.
