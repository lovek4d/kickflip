# A test run reports live lines the thread does not show

`board.mjs test`, a land and a send for review report their test run on the card they run for. The start ("full suite, <n> test files" or "<n> affected test files") and the result ("<pass> passed, <f> failed in <m>m <s>s") are ordinary status lines. The progress about every 2 minutes ("<done> tests run, <f> failing") is a status line marked `live`: it is the card's newest line, so it sets the card's live line and counts as movement, but `threadOf` leaves it out, so a 20-minute run adds two thread lines, not ten.

A builder's run reports under testing, a land's under landing.

The start counts test files and the updates count tests run, with no total: the runner names a test only when it runs, so the number of tests is unknown until the end.

For a board-launched builder this adds visibility, not staleness protection: a headless build is stale only when its process is gone. The protection holds for an untracked builder.
