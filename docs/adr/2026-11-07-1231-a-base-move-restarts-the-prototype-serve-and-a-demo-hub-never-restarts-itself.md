# A base move restarts the prototype serve, and a demo hub never restarts itself

A served prototype round's page went blank on the phone after it had shown (#435). hub.log showed three causes.

**A demo hub reached the host's Tailscale.** A try run's build script (`.kickflip/build`) runs a scratch hub with failing stubs first on PATH. Since [kickflip runs the tailscale CLI whose daemon is running](2026-11-06-1530-kickflip-runs-the-tailscale-cli-whose-daemon-is-running.md), `tailscaleBin` passes over a stub whose daemon isn't Running and picks the host's real CLI. Every demo hub that started then ran try.mjs's startup cleanup against the host and turned off the real hub's try ports, which the real hub put back on its next tick. A frame that loaded in that gap stayed blank. Now `KICKFLIP_TAILSCALE` names the only tailscale CLI kickflip runs (shared/tailscale.mjs `tailscaleCandidates`), and the build script sets it to its stub.

**A base move half-moved the serve.** `prototype base` checks the board's base worktree out at main while rounds are open. The demo hub serving it saw HEAD move and tried to restart itself, which fails behind the stubbed service manager, and then restarted only its board server for the new code, so hub and board ran different trees. Now (the owner's answer to gh435-base-move):

- The hub serving the base restarts the whole run when its worktree's HEAD differs from the commit the run started on (hub/try.mjs `serveBase`, on its 15-second tick). The new run keeps the same https port.
- `KICKFLIP_CODE_RESTARTS=off` turns off a hub's self-restart and its restart of a board server whose code changed (hub/hub.mjs). The build script sets it, so a demo hub never restarts for new code.

**The viewer stopped watching once it framed the page.** prototype-kit.js `served()` polled `api/try/prototypes` only until it set the iframe, so a serve that a land's hub restart or a base move brought back as a new run left the frame blank until a manual reload. Each base run now records `since`, the time it started, and `api/try/prototypes` returns it while the run is ready. The viewer keeps polling while the page is open (the owner's answer to gh435-frame-recover). A ready run whose `since` the frame doesn't show gets a new frame at the current take and state. A serve that's down shows "Starting the prototype site…". A poll that can't reach the board leaves the stage as it is, so a network blip doesn't reload a working frame.

**Footer gap.** Same card. On a phone, style.css sets `--app-bottom` for the bottom bar the page header becomes. The prototype page hides that header, but the variable stayed set, so the viewer footer sat about 53px above the bottom edge. The switcher's CSS now zeroes `--app-bottom` with `!important`, because style.css's `:has()` selector out-specifies anything plainer. This keeps [the phone footer paints complete and the frame ends at it](2026-11-11-1000-the-phone-footer-paints-complete-and-the-frame-ends-at-it.md) as it was meant.

This amends [a prototype round is a page in the board's base worktree](2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md).
