# The tailnet is opt-in with kickflip tailnet

Card #1008 (T-671), split 1 of T-665. Owner (11/17): "would like to split out tailnet stuff off the main path, so that
is something added with kickflip tailnet command instead of always on by default", then on the split: "default to off
with the new setting (exclude this machine this one time)".

Until now every `kickflip init` and `doctor --fix` mapped Tailscale `/` to the hub, and doctor, the Hub page and
`kickflip url` treated Tailscale as part of the install. The hub itself already listened on 127.0.0.1 only.

## Decision

- **One setting, `tailnet: true` in `~/.claude/kickflip/settings.json`.** Unset (or anything else) is off.
  `shared/tailnet.mjs` owns it (`tailnetOn`, `setTailnet`) and the hub's address (`hubUrl`: the tailnet's while on,
  `http://127.0.0.1:<port>/` while off). Callers read it on every call, never cached, since the command changes it under
  a running hub. `shared/tailscale.mjs` stays the daemon layer.
- **`kickflip tailnet on | off | status`.** On maps `/` to the hub through init's daemon pick, then records on, and
  prints the tailnet address or why it has none yet; with no Tailscale, or a failed mapping, it refuses and stays off.
  Off unmaps `/` and every try port on the recorded daemon (refusing to touch another daemon, as before), then records
  off. Status, the default word, prints which with the address; it exits 1 when on with no tailnet address.
- **Default off, with no migration.** An install whose Tailscale `/` already serves the hub reads off too; nothing
  detects it. This replaces the grill's "a mapped `/` records on" answer. Off means the hub stops depending on the
  tailnet, not that a mapping is torn down: init, doctor and uninstall leave an existing mapping alone while off, and
  only `kickflip tailnet off` removes it. The owner's own hub turns it on by hand once after this lands.
- **Off runs no tailscale.** Init skips the daemon pick and the mapping and says the hub serves this host, with the
  command. Doctor shows one optional `Tailnet` line, `→ kickflip tailnet on`, in place of its Tailscale, signed in,
  operator, `tailscale /` and try ports lines. The Hub page's Integrations row is named Tailnet in both states; off, it
  is grey, reads off with the command, and nothing waits on it. `kickflip url` and the URLs join prints are the local
  ones. Uninstall unmaps only while on.

## Consequences

- With the row off, `readiness.waiting('tailscale')` is null, so Try doesn't wait on it; Try and Serve serving on the
  host only, prototype frames, Settings › Sharing, share links and the on-host owner gate are split 2 of T-665 (T-672).
- Asks between hubs (T-666, T-667) ride the tailnet and refuse, naming `kickflip tailnet`, while it's off.
- The README and the skill's framing as a phone-first console are T-668's.
