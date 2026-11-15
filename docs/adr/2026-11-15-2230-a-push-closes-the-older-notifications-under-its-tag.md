# A push closes the older notifications under its tag

iOS home-screen web apps do not replace a notification when showNotification
is called with the tag of one already on screen; each stacks. The board's live
needs-you notification (2026-11-15-1300) relied on replace-by-tag and piled up
as "Hub Orchestrator (53)…(56)".

The service worker's push handler reads the notifications under the push's tag
before showing it, then closes those after the new one shows. It shows first
because iOS revokes push from an app whose push shows nothing. A push without a
tag closes nothing.

Updates after the first alert are already silent: the board sends a changed row
with `--silent` (board/server.mjs pushActions), which kickflip push passes to
deliver, which sends `silent: true` to the worker.
