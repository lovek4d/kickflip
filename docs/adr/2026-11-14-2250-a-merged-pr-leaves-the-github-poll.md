# A merged PR leaves the GitHub poll for good

The hub's poll (`hub/boards.mjs` `prsOf`) read only cards outside Done, so a merged card's PR left the poll and `checkGitHub` pruned its `threaded`, `acknowledged` and `prs` memory. A message reopens the card (#142), the PR re-entered the poll with no memory, and the next check replayed each "Approved." line, raised a merged change and closed the card back to Done.

`prsOf` now skips any PR the card stores as merged (`merged_at`), so a reopened card stays open until the owner closes it. The owner chose this over keeping the memory across Done (#536).

A card holding a merged PR beside an unmerged one still polls the unmerged one; a merged `merged_at` is only stored when the card closes, once every PR has ended.
