# Kickflip records the Tailscale daemon it uses, CLI or app

A Mac can run brew's standalone `tailscaled` and the Tailscale GUI app at once, each with its own daemon and its own tailnet node (#481). [Kickflip runs the Tailscale CLI whose daemon is running](2026-11-06-1530-kickflip-runs-the-tailscale-cli-whose-daemon-is-running.md) picked a CLI binary, the first whose daemon said Running. That picked a binary, not a daemon. Tailscale's macOS client (`safesocket_darwin.go`, `client/local`) shows why that isn't enough:

- A CLI run without `--socket` first asks the GUI app's daemon over its local TCP port (found through the app's `sameuserproof` file), and only falls back to `/var/run/tailscaled.socket`. So brew's CLI on PATH talks to the app whenever the app runs.
- `--socket <path>` sets `UseSocketOnly`, so the CLI talks only to that socket, which is brew's `tailscaled`.
- The app's bundle CLI, with the app quit, falls back to `/var/run/tailscaled.socket` and answers as brew's node.

Decision (owner's answers, gh481-*):

- **A daemon, addressed explicitly.** `shared/tailscale.mjs` lists daemons, not binaries: `tailscaled` reached by the first `tailscale` on PATH with `--socket /var/run/tailscaled.socket`, and `app` reached by the bundle CLI (`Tailscale.app/Contents/MacOS/Tailscale` in `/Applications` or `~/Applications`). On Linux there's one daemon, `cli`, the first `tailscale` on PATH. Every call runs `tailscaleArgv(daemon, args)`.
- **The pick rule (gh481-pick-rule).** Of the running daemons, the one whose `serve` maps `/` to the hub, else the app's, else the first. A daemon answering as an earlier one's node is a fall-through and doesn't count as running. With none running, the app's, else the first.
- **The record.** The pick is recorded in the hub's `~/.claude/kickflip/settings.json` as `tailscale: {kind, cli, socket?, node}`, `node` being the `Self.ID` it answered as. With no record, the first call picks by the rule and records it (gh481-no-record). A pick with no daemon running has no node and isn't recorded, so the next call picks again.
- **A recorded daemon that's down stays chosen (gh481-recorded-down).** Kickflip doesn't switch on its own. Where status is already read (doctor, the Hub page's Tailscale row, `tailnet-url`, the owner check, a site's address), a `Self.ID` other than the recorded node means another daemon answered in its place (gh481-address), and that read counts as not running. Doctor faults with `kickflip doctor --fix` when another daemon is running, else `tailscale up`.
- **doctor --fix and init pick again.** `runInstall` re-picks and records before mapping `/`, so `kickflip init`, which is `doctor --fix`, gets it too. A re-pick with nothing running keeps the old record.
- **Doctor's line (gh481-doctor-second)** names the chosen daemon and its machine, and notes any other running daemon with its machine, staying ok. For example `1.96.2 (the Tailscale app, /Applications/Tailscale.app/Contents/MacOS/Tailscale) on Loves-MacBook-Pro; also running: tailscaled, /opt/homebrew/bin/tailscale --socket /var/run/tailscaled.socket on mac-cli`.
- `KICKFLIP_TAILSCALE` still names the only CLI kickflip runs, with no record read or written ([a demo hub never touches the host's Tailscale](2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md)).

A write never lands on a daemon other than the recorded one. Each try-port `serve` (hub/try.mjs), install's mapping of `/` and uninstall's unmap first reads `status --json` and checks the node (`recordedFault`). On a mismatch, such as the app recorded and quit while its CLI falls through to brew's daemon, the write is refused with the recorded-daemon fault: "Tailscale's recorded daemon isn't running (<machine> answered in its place); start it, or run kickflip doctor --fix to pick again". A try port then fails its run with that line, install fails, and uninstall leaves `/` mapped and says why.

Rejected: asking the owner which daemon to use when both run (init runs unattended), and following whichever daemon runs now (a daemon that restarts later would move the hub between nodes).

This supersedes [kickflip runs the Tailscale CLI whose daemon is running](2026-11-06-1530-kickflip-runs-the-tailscale-cli-whose-daemon-is-running.md), and its "skipped … whose daemon isn't running" doctor wording.
