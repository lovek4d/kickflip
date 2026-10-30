---
status: superseded in part by ADR-0006
---

# The hub polls GitHub and sends pushes on one polling interval

Superseded in part by [0006](0006-pushes-only-when-something-waits-on-the-owner.md): only `action`, `prompt` and `fault` pushes exist. Questions, steps and prototypes skip the queue in the day, and the daily wakes run the reviewers' Slack digests, with no morning push. The polling interval, the poll's steps and the overnight hold below still hold.

One **polling interval** sets when the hub checks GitHub and when it sends queued pushes. It is `polling` in `~/.claude/web-ts/settings.json`, edited on the hub's Polling page (`/_hub/settings/polling`, opened from hub Settings' Polling row at `/_hub/settings`): a list of windows, each `{from, every_minutes}`, running until the next window's `from` and wrapping past midnight. The defaults are every 15 minutes from 8am, every 30 from 6pm and every 60 from 10pm. A window's slots fall every `every_minutes` from its `from`, and each window's start is a slot. `hub/schedule.mjs` owns the rules and the validation (HH:MM starts, 5 to 120 minutes, distinct starts). An old `push` block migrates on read, and the hub rewrites it as `polling` when it starts.

The Polling page shows the day as a 24-hour bar with one stretch per window, shaded darker the more often it checks. Tapping a stretch selects that window (`?w=HH:MM`), whose start, interval, split and removal sit under the bar. Each change saves at once through `validate`, with no Save button; `hub/schedule.mjs` `editPolling` turns a change into the settings to save.

On each slot, and once a minute after the hub starts, the hub runs one poll, never two at once:
1. **GitHub.** For each PR on any board's card that hasn't merged or been dropped (each PR of a wave `~/.claude/waves/monitor.json` watched, until [0040](0040-one-board-registry-for-every-hub-feature.md)), it runs `~/.claude/skills/monitor/monitor-gh.sh` and compares a summary with the last one in `~/.claude/web-ts/github-state.json`. A failure (such as `gh` not signed in) is logged at most hourly, and the poll carries on.
2. **Wake on a change.** When a PR's CI, review decision, unhandled comments, merge, mergeability or draft state changed, each board showing that PR gets one `github-change {prs: [{wave, id, pr, changes}]}` event through its `POST /_claude/events`. That wakes the owning session, which runs a monitor tick. A quiet poll wakes nobody.
3. **Checked.** When every PR was reached, those boards get `data/checked.json` with the current window's minutes, or the idle form when the board shows no open PR. Since the hub writes it on every poll, it no longer counts as Claude's activity on the board.
4. **Pushes.** Then the hub sends the queued pushes, each as its own notification, so their bodies follow fresh state. A monitor tick sends the queue again as it ends (`board.mjs checked`), so a push the woken session writes goes out then. Answers, questions and new rounds skip the queue in the day; `--urgent` always sends at once ([0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)).

**Daily wakes** (`wakes`, `["08:00", "09:00"]` by default, edited on the same page): the Slack bridge's morning push and reviewer digests run inside a monitor tick, and with no session crons a day with no GitHub change has no tick. So at each wake time, once a day, the hub sends every board, over the waves or its own items file, one `check-github {reason: "morning"}` event by the same path as `github-change`, whether or not any waves are watched, and the session runs one tick. `hub/github.mjs` `sendWakes` keeps each wake's last send day in `~/.claude/web-ts/wake-state.json`, so a restart never repeats one: a hub that starts at 08:40 sends the 08:00 wake then, and wakes due together go as one event. A wake missed on an earlier day is never sent (owner, card INT-50).

**Hold pushes overnight** (`hold_overnight`, on by default, a toggle under Quiet times on the same page): pushes queued in the last window, the one before the first window's start, wait for that start. Checks still run on the last window's interval. Off, pushes follow the same slots as checks. A poll within 2 minutes of the last window's start still sends the queue, so pushes queued before it go out.

Session crons ran `/monitor tick` every 30 or 60 minutes, which woke the session to find nothing changed most of the time and died with the session. Pushes went at once in the day, bundled every 30 minutes in the evening, and waited overnight, on a schedule unrelated to the checks.

The board must stay reachable from the phone with no PR to watch, so the Mac stays awake between waves: monitor keeps its `caffeinate` running when its last wave finishes, and the board's GitHub line rests in its idle form rather than turning late ([0021](0021-the-board-shows-github-checks-and-watcher-health.md)). The owner chose that over letting the Mac sleep until the next wave, and asked that the timers move from the session into the hub (round `site-v19`, question v19-idle-monitor, option B: "Timers should be central to the hub instead of per session if possible").

Considered:
- keeping the session crons and only moving pushes onto them;
- the hub waking the session on every slot, changed or not;
- stopping every check and letting the Mac sleep until the next wave (round `site-v19`, v19-idle-monitor C).

The owner chose that the hub checks GitHub and wakes the session only on a change, with checks and pushes on one interval and GitHub checked first (round `site-v20`, answer A: "15 min 8-6, 30min, 1hr overnight. Match notification config and update that to call it polling interval, both push notifications and GitHub checks. Check GitHub first so notifications are up to date"). Holding pushes overnight, configurable and on by default, came next (round `site-v21`, answer A: "Configurable default on for hold pushes overnight. Want the same schedule otherwise").
