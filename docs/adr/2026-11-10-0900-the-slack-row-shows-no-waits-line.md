# The Slack integration row shows no waits line

This supersedes in part [integrations show readiness, and features wait until theirs is ready](2026-11-02-1118-integrations-show-readiness-and-features-wait.md), like [the Linear row](2026-11-04-1850-the-linear-row-shows-no-waits-line.md): the owner asked for Slack's "Reviewer DMs and digests wait on this." dropped.

`INTEGRATIONS` in `hub/readiness.mjs` gives Slack a `waits` of null, so the page shows no line. Unlike Linear, Slack's sends still wait while it is not ready, so `GATES` keeps the sentence for `waiting('slack')`, which `review due` and the digest read.
