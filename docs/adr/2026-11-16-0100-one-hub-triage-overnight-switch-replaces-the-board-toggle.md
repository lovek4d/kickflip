# One hub Triage overnight switch replaces the board toggle

Extends [quiet hours list the overnight work, each job on by default](2026-11-15-0700-quiet-hours-list-the-overnight-work-each-job-on-by-default.md) and [triage runs once overnight on cards waiting on your answers](2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md): its `auto_triage` board setting is gone.

#799 (hub/T-377), from the owner's answer on T-268: "Hub toggle only; board toggle removed."

- **One switch.** Triage overnight is the `triage` job in `hub/overnight.mjs` `JOBS`, a row in the Quiet hours modal's Overnight work group. A board server's `checkTriage` and `triageDue` read it from the hub's settings.json each time (`overnightOn('triage')`), so flipping it applies to every board at the next minute check.
- **Last run.** The row's last run is the newest `overnight-triage` event across the boards' event logs. It never reads failed: a triage the session doesn't answer holds the pull and shows as a wait on its board.
- **Migration.** The hub's start runs `migrateTriage` once: if any board's board.json has an `auto_triage` key, the switch is on when any of them was true and off when none was, and the key leaves every board.json, so it doesn't run again. Without it a hub with no board on would turn triage on everywhere, as every job is on by default.
- **Gone from the boards.** Board settings loses its Triage overnight row; `settings set auto-triage` and the `auto_triage` key of `/api/settings` are no more.

Considered:
- Reading `auto_triage` as a per-board override beside the hub switch. The owner asked for the board toggle to go.
