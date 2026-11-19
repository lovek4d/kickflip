# The PIN page signs in at the eighth digit, and Devices holds Sign in a device

Refines [a device signs in with a 60-second PIN, and three misses block it](2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md).

## Decision

- **The PIN page has no Sign in button.** Eight digit boxes sit over one input (numeric keypad, `one-time-code`,
  focused on load), so typing, paste, autofill and backspace all go through it. The input keeps its first eight digits,
  dropping spaces and anything else a paste brings; the eighth locks the boxes, reads "Signing in…" and posts the form.
  A wrong PIN comes back as the page with red boxes and "Wrong PIN, N tries left". That line sits in a status slot of
  fixed height that is there, empty, before anything is typed, so nothing on the page moves between states. The blocked
  page is unchanged: it takes no PIN.
- **The hint reads the owner's words:** "Run `kickflip link` on its host, or go to Hub > Devices > Show PIN on a signed
  in device."
- **Hub settings › Devices holds sign-in.** After the signed-in devices come Blocked devices, a row per blocked client
  (its name, else its address; when it last tried) with Unblock (`DELETE /_hub/blocked/<key>`), or a line saying none
  is blocked. Last comes a Sign in a device row whose Show PIN opens the PIN dialog over the Devices modal. The hub
  page header no longer has a Sign in a device button. `GET /_hub/devices` answers `{devices, blocked}`.
- **`kickflip link` ends on use.** It prints the hub address, then one PIN line, `PIN: NNNN NNNN (expires in N s)`,
  redrawn in place, with a new PIN replacing one that expired or was voided and no line saying so. Once a device signs
  in with the PIN, the line reads `(used by <device>)` and the command exits 0; Ctrl-C voids the PIN and the line reads
  `(voided)`. To see the use, a device's record keeps the hash of the PIN it signed in with
  (`shared/owner-sign-in.mjs` `pinState`).

## Why

The owner asked for the button to go, since the eighth digit already signs in, and for paste to keep working without
the status line shifting the page. They also asked for the Devices modal to list blocked devices and to be where a new
device gets signed in, and for `kickflip link` to stop once its PIN is used.

## Considered

- One visible input with no boxes (prototype take A). The owner picked the boxes.
- Sign in a device as a button at the top of Devices (take A). The owner picked a row at the bottom.
- Telling a used PIN from a voided one by the PIN dropping out of the live list. That can't tell a use from a block,
  which voids every live PIN, so the device record keeps the PIN's hash instead.
