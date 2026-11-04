# The Linear integration row shows no waits line

This supersedes in part [integrations show readiness, and features wait until theirs is ready](2026-11-02-1118-integrations-show-readiness-and-features-wait.md) on which rows name the features that wait: a not-ready Linear row shows what is missing and its Hub settings link, and no "wait on this" sentence. The owner asked for it dropped.

`INTEGRATIONS` in `hub/readiness.mjs` gives Linear a `waits` of null; the page renders the line only when a row has one, and `waiting('linear')` answers null. The other rows keep theirs.
