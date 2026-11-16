# A digest counts every unapproved PR its thread links

A reviewer's link goes out once the hub reads the PR open and out of draft; checks play no part (`linkOwed`). The digest
used to leave out a PR whose checks fail, so a day could open with "All reviewed" and a link to an unreviewed PR right
under it.

The digest now lists, and its header counts, every open, non-draft, unapproved PR whose link went or is owed to the
reviewer, failing checks included. The count always matches the links in the thread. This changes the count in
[one digest opens each day's thread](2026-11-14-0449-one-digest-opens-each-day-thread.md).

Considered: holding a failing PR's link until its checks pass. Refused: the owner asked that the digest line up with when
the reviewer gets the DM.
