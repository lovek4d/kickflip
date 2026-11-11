# A merge refuses when it can't read the PR's reviews

`fetchPR` used to read a failed comment or review list as `[]`, so a merge under a REST-only limit (or any gh failure) saw no reviews, skipped the commits-after-approval check, and `gh pr merge` (GraphQL) went through.

Now every failed list throws `<repo>#<pr>: <gh reason>` with `limited` attached, like the view, in both callers: `mergeCard` writes its red gh-limited "Not merged" line and fails, and `board.mjs pr` refuses. A merge reads only the view and reviews (`comments: false`), since it never used the comment lists.
