# The Merge button keeps its colour while it merges

Once a Merge tap lands, the card has no Action needed, so `resolvedBy` is null and the button fell back to the blue `primary` class while it spun. mergeButton (board/public/ui-cards.js) now picks `resolves` when the card is merging as well as when `resolvedBy` is merge, so the button stays orange from idle through the tap and the merge. The other BUSY buttons take their class from nothing that changes when they are tapped.
