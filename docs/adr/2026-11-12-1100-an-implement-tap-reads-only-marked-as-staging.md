# An Implement tap reads only "Marked as staging"

An Implement tap used to leave two lines: the owner's "Implementation requested", then the board's "Marked as staging". The owner dropped the first: staging is learned as the response to the tap.

- A bare Implement writes no command line of its own (store.mjs `implementAsIs`). The thread shows "Marked as staging", then "Marked as ready". A message sent with the tap still shows as the owner's message.
- "Marked as ready" carries the orchestrator's check: `item set --phase ready --text` puts the first line of the text on the readied line, cut to 100 characters ("Marked as ready · Checked against T-172…"). The full text stays in the notes.
- The staging phase and its pill word stay.
