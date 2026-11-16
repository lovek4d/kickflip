# The usage gate sends the bar's tone and the banner's text

The browser no longer turns usage numbers into a colour or a sentence. `hub/usage.mjs` puts a `tone` on each usage
window (`stale`, `full` from 90%, `high` from 75%, else `ok`), and `shared/usage-gate.mjs` puts a `banner` on the gate:
`{kind, text, until}` or null. `kind` is `manual` (Resume), `going` (Stop), or `paused` and `near` (Keep going). `text` is
the whole sentence with `{until}` where the time goes, `until` being an ISO time or `forever`.

The time stays the browser's to format: only it knows its own timezone, so `HubUI.pauseBanner` swaps `{until}` for
`usageClock(until)`. Everything else it draws, the icon and the button, follows `kind`.

The gate also sends `paused`, true while it holds new work as a pause, usage or manual. The sidebar's Hub row and board
rows, the logo's dot and the header's time read it instead of comparing `state`.

The sidebar's second Claude week bar is the gate's `week`: `high` or `full` while the week is live within the near band
under the pause line, else null and the bar is hidden. The banner kind also drives the Keep going toast: `going`,
`near-going`, `near` or `paused`.
