# A release moving to publishing posts its own line

A release card's thread posted a line only for published and failed, so a rerun of a failed run left the red "failed" line as the last one while the run went again, and an untagged release that got its tag said nothing.

markRelease (board/cards.mjs) now posts `release-publishing` when the state becomes publishing from failed ("its run is rerunning") or from untagged ("its tag has a run"), linking the run. The line is orange, as a run in progress. It posts once, on the change of state.

A single table for every tracked state change's line is a separate decision.
