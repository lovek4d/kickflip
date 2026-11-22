# Doctor offers to delete only old board clones no board uses

**Doctor lists, and `--fix` asks about, only the old clones no board records.** A clone in an old place that a board's recorded repo is in (open, closed or starting) is in use, so deleting it would break that board; it gets no row and no question. This narrows [board clones live outside the package](2026-11-04-0103-board-clones-live-outside-the-package.md), whose doctor row named the boards using a clone and asked about it anyway. Each remaining row reads `<path> is in an old place and no board uses it`, and `--dry-run` prints only those clones.

Considered:
- keeping the row for a used clone with a warning: the owner could still answer yes by habit and break the board.
