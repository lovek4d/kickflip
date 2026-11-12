# The npm check rides the hub's tick every 15 wall-clock minutes

Changes the cadence in [the update row shows only New version and Reload](2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md): the check, the pull, the clone rule and the self-restart stand.

An npm install's hub on a laptop logged its 0.7.0 > 0.7.1 pull and then nothing for 5 hours after 0.7.2 was published (#525). The code allowed two silent causes: the hourly `setInterval`, whose clock on macOS stops while the Mac sleeps, so a mostly-asleep laptop goes hours without a check; and a `kickflip update` that never exits, which holds the pull open and makes every later check return without a word. A check that found nothing newer logged nothing, so the log couldn't tell them apart.

- **Cadence**: the hub's 15-second tick, which already drives the GitHub poll by wall clock, calls `upgrade.tick()`, and it checks when 15 minutes of wall-clock time have passed since the last check began. The hub's start checks at once, and a tap on the hub page's version counts as a check. The separate hourly `setInterval` is gone. GitHub keeps its own cadence (1 minute here, 5 away).
- **A hung pull**: a pull still running after 10 minutes is aborted; the hub kills `kickflip update` and npm under it (their process group), logs `kickflip update killed after 10 minutes`, and the next check tries again.
- **A trace**: each check that hears from npm logs `kickflip update check: npm <latest>, running <installed>` to hub.log when that line changes, and otherwise at most once an hour. Every update line starts with `kickflip update`, so `rg 'kickflip update' hub.log` shows the checks, the pulls, their exits, kills and failures.

Considered: one durable 15-minute poll for every hub timer. The one durable poll already exists (the 15-second tick); the other timers are short per-job loops or thresholds already read by wall clock, so only the npm check moved onto it.
