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

## Amended 2026-11-17: the declarative push spike, and the push log

It still stacked (#1019): the owner saw "Hub Orchestrator (N)" repeated, the
board row's own updates. An iOS home-screen app must show a notification for
every push, and getNotifications in a later run of the worker apparently
returns nothing from an earlier one, so closing the older ones can't work there,
and every silent update and every close puts up one more.

The owner chose to try declarative Web Push (Safari 18.4) before falling back.

**Apple gets declarative pushes.** hub/push.mjs sends a subscription on
web.push.apple.com `{web_push: 8030, notification: {title, body, navigate, tag,
silent, app_badge}, id}`: the browser shows the notification itself, with the
board's tag, without running the worker. `navigate` is the push's URL made
absolute against the hub origin the device subscribed from. `mutable` is left
off, so the worker doesn't run for it; where the browser doesn't support
declarative push, the worker gets the payload and shows it as its own
(hub/sw.js fromDeclarative). Other devices keep the worker's payload.

**Apple gets no close push.** A close would show a notification of its own
there. A board's row stays on an iPhone after nothing waits; the board and the
next push's badge carry the live state.

**The push log.** Each push sent to each device is a line in
`~/.claude/kickflip/push/log.jsonl` (ts, id, tag, title, silent or close,
host, device id, declarative, status), the last 1000 kept. The worker reports
each push that carries an id to `POST /_hub/push/report` with its version, the
notifications it found under the tag before showing, how many it closed, and
whether the payload was declarative; the report joins its push in
`kickflip push log`. A declarative push to an iPhone with no report means iOS
showed it itself; a report with `declarative payload` means it didn't.

**Still open.** Whether iOS replaces a declarative notification by tag is what
one evening of real pushes answers, from the push log and the owner's phone.
If it does, this stays. If it doesn't, Apple subscriptions get one alert per
stretch: the row's first alerting push only, no silent updates, with the app
badge carrying the count. Record the outcome here.
