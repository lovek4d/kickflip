# A digest reply is its PR's link

When a day thread opened, its digest listed a PR whose link was owed, and the link then went too, so the reviewer got the same PR twice in a row: on demand, when the link opened the thread, and at the weekday digest for a PR that left draft overnight. `slack link` on a day with no thread did the same, then refused as the link had gone.

**The digest's reply for a PR is that PR's link** to a reviewer it hasn't gone to (`board/slack-store.mjs` `postDigest`). As each reply posts, its ts is recorded as the reviewer's link in `pr-slack.json` (`links.<name>`, with the day thread's ts), not once the whole digest is up, so a digest that fails part way counts the replies that went and resumes with the rest. A reply to a reviewer whose link went on an earlier day joins the PR's `replies` as before (id `digest-<date>`), and gets the link's reactions. The reply that is the link is followed once, as the link, so its reactions are owed once.

**The links wait on the digest.** `hub/review-send.mjs` reads what is owed again after the digests go, so a PR the digest sent owes no link, and a link to a reviewer whose digest is still owed fails as "the day's thread waits on its digest" until the next poll: the rest of the digest may be that link. A PR the digest doesn't list (an approved one) still gets its own link once the digest is up.

**`slack link`** on a day with no thread opens it with the digest as before; when the digest's reply was the link, it reports the link sent and posts nothing more.

Everything that reads a reviewer's first link (the task's review time, Stale, the digest's “_(N days old)_”, the hub's links list) reads the digest reply as it, since it is recorded where a link is.

## Considered

- **Leave the PR out of the digest while its link is owed.** Rejected: the digest's count and list would miss the PRs the reviewer is newest to, and the weekday digest and the on-demand one would differ, which [one digest opens each day thread](2026-11-14-0449-one-digest-opens-each-day-thread.md) rules out.
- **Record the links once the whole digest is up.** Rejected: a digest that failed after some replies would leave those PRs owed a link, sent again as a second message.
