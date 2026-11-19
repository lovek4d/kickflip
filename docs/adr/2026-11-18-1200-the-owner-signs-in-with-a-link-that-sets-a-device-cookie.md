---
status: accepted
---

# The owner signs in with a link that sets a device cookie

The link is replaced by a PIN: [a device signs in with a 60-second PIN, and three misses block it](2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md).
The cookie and what needs it stand as below.

Replaces the loopback-is-owner bullets of
[only the signed-in owner changes permissions or restarts](2026-11-04-0502-only-the-signed-in-owner-changes-permissions-or-restarts.md)
("A direct loopback caller is the owner") and
[the whole hub answers only the owner](2026-11-04-2156-the-whole-hub-answers-only-the-owner.md)
(every loopback caller is the owner).

An external security review (T-677, finding 2) found that loopback was the owner: the builders and planners a board
launches run on the host, so any of them could POST a `script-run` and run a waiting script, answer its own
permission prompt or flip a setting. Each board server listens on 127.0.0.1 and trusted every caller, so the hub's
gate didn't cover a request straight to a board's port. The owner's answers (T-677, 11/17): a sign-in link that sets a
device cookie; the sign-in covers every page request, reads included; the CLI stays open to agents.

- **A link signs in one device.** `kickflip sign-in` prints `http://127.0.0.1:<port>/_hub/sign-in?t=<token>`, and while
  the tailnet is on the same link on the tailnet's address. A link lasts ten minutes and signs in one device.
  `shared/owner-sign-in.mjs` keeps `~/.claude/kickflip/owner-sign-in.json` (0600) with the sha256 of each link token and
  device secret, never the secrets. `kickflip sign-out` signs every device out.
- **Opening the link asks; Sign in uses it.** `GET /_hub/sign-in?t=` answers a page with the link filled in and a Sign
  in button; only its POST uses the link up, so a link preview (Messages fetching it on the Mac) can't. The signed-out
  page has the same field, so a home-screen web app, which has no address bar, signs in by a pasted link. The POST sets
  `kickflip_owner=<secret>; Path=/; Max-Age=<400 days>; HttpOnly; SameSite=Lax` (`Secure` when tailscale serve's
  `X-Forwarded-Proto` is https) and lands on the page that asked, a path on this host only.
- **Every request needs the cookie, but four kinds.** The hub, each try relay and each board server check it on
  every request and upgrade, after the tailnet gate (board/on-host.mjs ownerGate). Without it:
  - a browser gets the sign-in page (401), and anything else 401 `{error}`, with `X-Kickflip-Down: signed-out`;
  - a process on the host gets the **agent paths** with no cookie: a caller straight to loopback, with no
    `X-Forwarded-For`, `Origin` or `Sec-Fetch-Site` (Node's fetch sends `Sec-Fetch-Mode`, so that one is allowed). The
    hub's are builds, serves and pulls, the CLI's poll, status and board restart, the permission hooks' prompt, wait,
    give-up and denied notes, `needs.json`, and `board.mjs`'s sends to the owner's other hubs (`/_hub/peers/*`); a
    prompt's answer is not one. A board's are its health, needs, stream
    and working list, the CLI's `changed` note and `POST /_claude/events` of any kind but the owner's: a card tap
    (domain.mjs `TAP_KINDS`; a thread message only when it carries Reply's or Implement's intent, since the hub's Slack
    intake posts plain ones), a script's Run or Decline, an answer, a held review's Post it or Skip and the reviewers
    Save;
  - a read of the app's code and icons is open: the hub's `/_hub/app/`, icons, manifest, `sw.js` and CSS, and a board's
    non-HTML files, the site's own `public/` among them. The sandboxed preview stage loads these from an opaque origin,
    which sends no Lax cookie
    ([previews run in a sandboxed opaque origin](2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md)), a
    browser fetches the manifest with none, and iOS's installer fetches an install's files with none. A page (`.html`,
    the shell), an API and an upload need the cookie;
  - another of the owner's hubs gets `/_hub/peer/{ask,answer,boards}` on the tailnet gate alone, its
    `Tailscale-User-Login` the owner's, since another hub holds no cookie
    ([a board asks a board on another of your hubs while it's online](2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md)).
- **A board checks its own requests.** The hub passes a board site's requests through, cookie and all, and its server
  decides, since it knows its files and event kinds; it reads the same file. The hub decides for its own paths, the
  shell of a board's URL, and every site that isn't a board, whose server never gets the cookie. A try relay never
  passes it to the card's app either: that is agent code.
- **Tests sign in through the servers' option.** `startServer`, `startHub` and `createTryManager` take
  `signedIn(req)`; the test fixtures default it to a signed-in device, and the sign-in tests pass the real check.

## The same-user limit

A process running as the owner's OS user can run `kickflip sign-in` and use its link, or read the sign-in file. The
cookie stops a page, or a one-line request from a builder, acting as the owner; it doesn't stop a process set on it.
SECURITY.md says so.

## Not covered

- The hub board's demo hub, which a hub card's Serve runs on a try port with its own home, asks for its own sign-in:
  the relay never hands the owner's cookie to a card's app.
- A board page that loses its sign-in mid-visit (after `kickflip sign-out`) shows its requests failing; a reload shows
  the sign-in page.
