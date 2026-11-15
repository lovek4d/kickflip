# A Merge-mode Done card shows its commit as a badge

A land in Merge mode (board.json prs off) records the commit it fast-forwarded the base to on the card (`landed_sha`, from `landPrepared`'s `commit`). The board view gives a Done card with that sha a `commit`: the short sha, and a link to the commit on the board's GitHub repo, or no link when the board has no GitHub repo.

The card draws it as a purple badge of the short sha in mono, in the PR badge's place (the same tone as a merged PR), and the open card has a Commit row beside Branch.

Cards that landed before this have no `landed_sha` and show no badge. They are not backfilled: the sha of a squashed commit can't be told from the Refs trailer without guessing between commits that name the same card, and the badge is for what lands from now on.

PR-mode cards are unchanged: their land goes through a PR, never records a sha, and keeps the PR badge.
