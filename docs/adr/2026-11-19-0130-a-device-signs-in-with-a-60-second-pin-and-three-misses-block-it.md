---
status: accepted
---

# A device signs in with a 60-second PIN, and three misses block it

Replaces the sign-in link of
[the owner signs in with a link that sets a device cookie](2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md);
the device cookie, what needs it and the agent paths stay as that ADR says.

The owner's second device got "That sign-in link has expired or was already used" twice: their phone added a space to
the pasted link, so the field held no token (T-736). They asked for a PIN in its place, then (11/18): "pin should only
survive 60 seconds from creation, and thrown out when the hub dialog is closed. if dialog still open after 60s auto
refresh the pin. also replace the terminal command with kickflip link … throw away the current landing page, just land
on a pin entry when not permitted", and a lockout: "lock the device out with 'kickflip unblock' as the escape hatch …
blocks are permanent until kickflip unblock". The final visual
(visuals/T-736/sign-in-by-pin-landing-blocked-sign-in-a-device-dialog-devic.html) is the confirmed look.

- **A PIN is the only way in.** Eight random digits (`crypto.randomInt`), live 60 seconds from creation, signing in one
  device. `shared/owner-sign-in.mjs` keeps the sha256 of each live PIN in `owner-sign-in.json` beside the devices'.
  Eight digits hash-brute-force offline in moments, but the file is 0600 and whoever can read it can make a PIN anyway
  (SECURITY.md's same-user limit); the hash keeps a PIN out of a backup or a pasted file.
- **Two places make one.** `kickflip link` prints the hub's address (the tailnet's while it's on, no token) and a PIN,
  a fresh one each 60 seconds while it runs; Ctrl-C voids the live one. A signed-in hub page's **Sign in a device**
  dialog shows the address, the PIN and a draining bar, asks for a fresh PIN at 0 and voids the live one as it closes
  (`POST /_hub/pins`, `DELETE /_hub/pins/<pin>`). `kickflip sign-in` and the `/_hub/sign-in?t=` link are gone; an old
  link opens the PIN page.
- **The landing page takes the PIN.** A request without the cookie gets front-door.mjs's page with one PIN field; the
  field drops whitespace, as the server does, and sends the form at the eighth digit. A wrong PIN answers the page with
  "Wrong PIN, N tries left".
- **The third miss blocks the client.** A client is its tailnet node by name for a request tailscale serve forwarded
  (`tailscale status` maps the forwarded address to a node), else its address (board/on-host.mjs clientIdentity), so
  every browser on a blocked phone is blocked, and clearing cookies doesn't escape it. A MAC address never reaches the
  hub. The third wrong PIN from one client voids every live PIN and blocks it; misses never fade with time: only the
  client's own sign-in or `kickflip unblock` resets them, so three in total block it. A blocked client gets the same landing page reading "This device has been
  blocked, use `kickflip unblock` on the host machine" on every page, a right PIN included, and each try updates its
  last attempt. Only `kickflip unblock` lifts it (fzf over name, address and age of last attempt, or a name or
  address as its argument). Loopback clients share one address, so three misses on the host's own browser block the
  host's loopback until unblocked; the host can always run the CLI. A signed-in device keeps working while its
  client is blocked: the block guards the PIN, and the cookie is already proof.
- **Devices are listed and removed one at a time.** Each device keeps its name (its tailnet node, else the browser
  and OS from its User-Agent), address, when it signed in and when it was last seen, which the hub writes at most
  every 5 minutes as its pages ask. Hub settings › Devices lists them, this device marked, each with Remove;
  `kickflip devices` lists them and `kickflip unlink` removes one (fzf, or a name). `kickflip sign-out` still signs
  every device out. A device signed in by link before this lists as "A device".

## Not covered

- The hub board's demo hub (.kickflip/build, T-715) signs itself in with `makePin` and `redeemPin` in its own home
  once T-715 lands; this change has no link left for it to use.
- A try port's own refusal page posts its PIN to that port, where no sign-in route answers, as its link field did.
