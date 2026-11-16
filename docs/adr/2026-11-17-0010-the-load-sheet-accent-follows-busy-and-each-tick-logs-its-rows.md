# The load sheet's accent follows busy, and each tick logs its rows

Status: accepted (owner, 11/16, card T-568)

The load sheet (2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md) opens at any load since 2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md, but drew its accent, the now figure and the sparkline, orange whatever the load. The owner asked for orange only when busy, else green, and for those rows to be logged every tick to audit later.

Now:
- `/_hub/machine.json` carries `busy`, the state the hub's tick kept (`machine-state.json`). The sheet's `ls-load` block takes `ls-busy` while it is true; its accent is `--color-notice` (orange) then and `--color-success` (green) otherwise, per the colour priority in AGENTS.md. The hour average stays the text colour.
- Each group row also carries `ppid` and `command`, ps's own, beside the shortened `cmd` the sheet shows.
- Each hub tick that reads the load writes one JSON line to `~/.claude/kickflip/logs/host-load.jsonl`: `{ts, load, cores, busy, groups: [{name, count, cpu}], rows: [{pid, ppid, command, cpu, age, group}]}`, `name` and `group` being the group's key (orphan, suite, session, builder, other). A tick where `ps` gave no answer writes empty groups and rows.
- The first write of a new local day moves the file to `host-load-<its day>.jsonl`; rotated files older than 14 days are deleted at the same write.

Not here: the rows are the sheet's (the busiest Other rows only), not every process on the Mac.
