# Kickflip runs the Tailscale CLI whose daemon is running

A Mac can have brew's `tailscale` formula and the Tailscale GUI app installed together, each with its own daemon. `tailscaleBin` (`shared/tailscale.mjs`) used to take the first `tailscale` on PATH and only fall back to the app bundle's `Tailscale.app/Contents/MacOS/Tailscale` when PATH had none ([a board starts and lands without Tailscale](2026-11-04-1513-a-board-starts-and-lands-without-tailscale.md)). On the owner's GUI-app Mac (#410), brew's formula was still on PATH after Tailscale moved to the GUI app, so kickflip kept asking brew's stopped daemon. Doctor saw "not connected", `doctor --fix` mapped nothing onto the GUI app's daemon, and that node answered nothing on 443.

Decision (owner, q410-pick-rule): kickflip lists every candidate in its old order, PATH then the app bundle. With more than one, it runs the first whose `status --json` says `BackendState: Running`. With none running, it runs the first found, so doctor's fix names that one. A lone CLI is never asked, so a host with one Tailscale runs no extra command. The pick is made on every call, since starting or stopping a daemon changes it. Doctor, `doctor --fix`, `tailnet-url`, the hub's Tailscale row, the owner check and the try ports all run the CLI it picks.

Doctor's Tailscale line also names a CLI it passed over (owner, q410-doctor-names-both), for example `1.96.2 (/Applications/Tailscale.app/Contents/MacOS/Tailscale); skipped /opt/homebrew/bin/tailscale, whose daemon isn’t running`. It stays ok, with no fix to run.

Rejected: always preferring the app bundle (breaks a Mac that runs brew's daemon with the app installed but signed out), and removing brew's formula for the person (it's their install).
