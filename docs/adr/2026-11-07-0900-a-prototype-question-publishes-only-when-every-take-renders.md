# A prototype question publishes only when every take renders

The owner (#353's gh353-fold round), verbatim: "Takes fail to render, fix and file ticket to prevent this"

Cause: #353's takes drew threads with `BoardUI.threadMessages`, but `board/public/prototype.html` never loaded `ui-threads.js`, so every take threw `BoardUI.threadMessages is not a function`. Planners are told to check takes in headless Chrome; nothing enforced it.

- `question add` (board.mjs, through `store.addQuestions`' `renderCheck`) runs `render-check.mjs` for each recorded prototype its questions link, after the existing validation and before the question is staged or published. A planner's staged questions are checked when added, so a refusal reaches it at once rather than when its builder done publishes them.
- `render-check.mjs` serves the page the board serves (`prototype-page.mjs`, shared with the server) and loads each take with `?variant=<KEY>` at 390px and 1280px in headless Chrome. It refuses, naming take and width, on an uncaught exception, a console error, a failed resource load, or an empty stage.
- `prototype.html` now loads `ui-threads.js`, so the kit's `BoardUI` has the thread renderer.
- A take that throws already shows "Take X failed: <message>" in place of the take on the owner's page (prototype-kit.js), not a blank; that stays.
- `KICKFLIP_RENDER_CHECK=off` skips the check; board-fixture.mjs sets it for the CLI tests, whose stub takes draw nothing. No Chrome at `$CHROME` (default the macOS Google Chrome) is a refusal, not a skip.
- Chrome is started with the account's own home, not `$HOME`: under a different `$HOME` its first navigation never answers.
