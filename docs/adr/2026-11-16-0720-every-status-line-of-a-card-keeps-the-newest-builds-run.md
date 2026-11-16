# Every status line of a card keeps the newest build's run

A status line is drawn in the group of the run it names. After a failed land the card's main record is the lander's and the builder's run sits in a past record, so a test report or landing line that looked for a non-lander build found none and wrote no run, and the thread drew it loose.

The landing line and the test report now take the card's newest build record, a lander's included: a lander's run folds into the build it lands (domain.mjs sectionOf), so the section stays one. When a record is open but no build record can give a run, the writer refuses rather than write a loose line.

A test run that is retried by the lander writes its own start and result lines; those are two runs, not one written twice. The intake triage run that once wrote run-less lines no longer exists (its last line is from 11/07).
