# Previews run in a sandboxed opaque origin

A prototype's takes and every page an agent writes into a board's own
`public/` (a visual, a hand-written prototype page) are code the owner didn't
write, and they ran on the board's origin: a take could call the owner's APIs
with the owner's browser (the external review's finding 1, split from T-677).
They now run in an opaque origin, which reads nothing of the board's.

- **The stage is a document of its own.** A take-file round's viewer,
  `prototype-<topic>.html` (prototype.html: the switcher's bar, the Round pill,
  Choose this and its draft), stays on the board's origin. The takes draw in its
  stage, `prototype-<topic>.stage.html` (prototype-stage.html, which loads the
  same app scripts so `BoardUI`, `HubUI` and the kit stay globals), framed with
  `sandbox="allow-scripts"`. The viewer sends each switch as
  `{kickflip: 'prototype', take}`, the shape a served round's page already
  takes; the stage sends back ←/→ and swipes made in it as
  `{kickflip: 'prototype-step', step}`. The dark-mode pick rides the frame's
  URL, since the stage can't read localStorage.
- **The header, not only the frame attribute.** The stage, and every file served
  from the site's own `public/`, carries `Content-Security-Policy: sandbox
  allow-scripts`, so the page is opaque framed or opened alone, and a script or
  SVG there can't run on the board's origin either. No `allow-same-origin`,
  forms, popups or top navigation. The board's own files (board/public, the
  starter's, shared) don't carry it.
- **Module scripts get CORS for `null`.** A sandboxed page fetches a module (a
  take) with CORS from Origin `null`, so a `.js` or `.mjs` file of the site's own
  carries `Access-Control-Allow-Origin: null`. Any opaque origin can read those
  files; they are agent-written previews, not owner data.
- **The reader hears a site page by message.** The reader sheet read a framed
  page's title and caught its link taps through the frame; it can't reach an
  opaque page. The server adds `preview-frame.js` before `</body>` of each HTML
  page of the site's own, which posts `{kickflip: 'page', title}` on load and
  `{kickflip: 'page-link', href}` for a plain tap on a link that would open in
  the frame (not one to a place on the page). The reader takes a message only
  from the frame it shows, and only an http(s) link: a board view opens as
  before, any other page in the frame. A page can send a link no one tapped,
  which opens at most a view of the board.
- **The render check loads the stage.** render-check.mjs loads
  `prototype-<topic>.stage.html?variant=<take>` with the same headers the board
  sends, so a take that reads the board's storage fails its check instead of the
  owner's page.

## What changed for pages

- A hand-written prototype page (the ones from before the template, which load
  prototype-switcher.js themselves) still draws, but its Choose this can't keep
  a draft in the board's localStorage: open the round from its question instead.
- A take or visual that fetched the board's API, read localStorage or reached
  into the page around it no longer can; it draws from the kit's fake data.
- The stage scrolls inside its frame, which ends at the viewer's footer, as a
  served round's page already did.

## Not covered

- The board's static roots put the site's own `public/` first, so a file there
  named like an app script (`app.js`) is served in its place to the app. That is
  the same-OS-user limit (an agent can write any file the board serves), and is
  left to the owner sign-in and threat-model work split from T-677.
- `/uploads/` files are served as before.
