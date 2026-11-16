# Older code reads only as the New server version banner

The hub ran a "hub link" that failed while it ran older code than its files, which turned the Hub row and Health card amber **degraded** with "runs older code than its files; restart it". The New hub version row (and a board's New server version row) already says this and carries the Restart, so the same fault was said twice, and the second one called a hub that works degraded.

Running older code is no health state. The hub link, `hubLink`, and the stale term in `hubHealth` are gone: the hub reads degraded only while a board link stays broken, and down only while a site is down. The New hub version and New server version rows, and the automatic restart behind them ([new server code waits behind a Restart row and restarts itself once idle](2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md)), are unchanged.

This supersedes the hub's own link in [every builder works in a worktree, and the hub's own fault shows once](2026-10-30-1654-every-builder-works-in-a-worktree.md) and the stale-code term in [the hub reads Healthy, Degraded or a site down](2026-11-03-0501-the-hub-reads-healthy-degraded-or-a-site-down.md).
