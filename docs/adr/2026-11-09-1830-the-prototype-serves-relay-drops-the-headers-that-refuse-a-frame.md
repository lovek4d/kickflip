# The prototype serve's relay drops the headers that refuse a frame

A served prototype round is framed by the board's page. The board is on :443 and the serve on :85xx, so the frame is cross-origin, and an app that sends `X-Frame-Options` (even SAMEORIGIN) or a CSP `frame-ancestors` is shown by Chrome as "<host> refused to connect."

The try relay for the board's base prototype worktree (key `prototypes`) removes `X-Frame-Options` and the `frame-ancestors` directive of `Content-Security-Policy` from the app's responses. A card's or Main's relay keeps them: only the prototype serve exists to be framed by the board.

Cause was not confirmed on Paddock Web's Mac (its diagnosis output was never posted); the strip is the owner's chosen fix for the frame-headers case.
