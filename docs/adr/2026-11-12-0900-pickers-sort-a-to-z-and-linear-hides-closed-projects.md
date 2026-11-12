# Pickers sort A–Z, and Linear's project picker hides closed projects

Every list a picker draws sorts at its source, case-insensitive and numeric-aware (`shared/a-to-z.mjs`, so `build-2`
comes before `build-10`): Linear teams by key, each team's projects by name, branches, and build targets.

- The Linear project picker lists open projects only: `teams()` drops projects whose status type is completed or
  canceled. A board whose saved project has since closed shows the first open project until the owner picks again.
- A branch list puts the default branch first, the rest A–Z. Build target's Default stays first; New project… stays
  last, and the client re-sorts the project list after a project is made.
- Kept in their own order: the Lane picker (pipeline order) and the New board repo list (newest push first).
- Reviewer lists already sorted A–Z.
