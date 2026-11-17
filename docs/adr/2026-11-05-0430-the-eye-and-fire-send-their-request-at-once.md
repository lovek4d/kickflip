# The eye and fire send their request at once

Supersedes the "Both are toggles… that Send carries" line of
2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md.

## Decision

A tap on a thread composer's Prototype or Grill posts `prototype-request` or `grill-more` immediately,
through the same path as Reply: with the box empty it is the bare request (a gray "prototype requested" / "grill
requested" line); with text or files it is that message with the request in its footer. The tapped button spins until
the request shows in the thread, the draft and files clear, and the thread reloads.

No toggle state remains: no `dataset.flag`, no `aria-pressed`, and the line under the box saying what Send will post
is gone. `/prototype` and `/grill` typed in the box still ask for one when Reply is pressed. While files upload, Prototype
and Grill are disabled like the send buttons. On a Todo card they never carry `intent: 'build'`; Reply and build
stays its own button.

## Why

A toggle that rides on the next message was easy to set and forget, and the hint line existed only to explain it.
A tap that acts says what it does.
