# The auto pass re-reads a pause before dropping it

A Hold writes `held` to the card's item file and then the pause to the builder's record. The auto pass's snapshot reads each item file first and its records after, so a Hold landing between the two reads gave a snapshot with the pause and no hold. `pauseWork` listed that pause as a drop and `dropPause` took it off the record, so the Hold's builder never paused (the headless Hold test read `pause` undefined). A block's pause (setItem) and a bump-out's (stop.mjs) write in the same two steps.

`checkPauses` now builds a fresh board before dropping and drops only the pauses the fresh read lists as drops too (domain.mjs `confirmedDrops`). A write landing after the fresh read still leaves a record the next pass sees whole.

Chosen with the owner on #507 over serialising the tap and the pass. The headless Hold test's check reads one deepEqual over done, pause and lane, so a failure prints what it read.
