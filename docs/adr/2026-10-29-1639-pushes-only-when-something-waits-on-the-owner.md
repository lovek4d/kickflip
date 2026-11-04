# A push goes out only when something waits on the owner, on the hub's schedule

A push is one of three kinds, and nothing else pushes:
- **action**: a card's Action needed appears or changes. That is a question or prototype pick, manual steps, a reviewer's suggestion that needs the owner's call, a draft waiting on Ready, Merge, or an ask waiting on the owner's Done (the `actionOf` kinds in `board/domain.mjs`). A card whose action changes, such as a new question on a card already asking, pushes again under the card's tag, which replaces the notification on the device it reached and alerts again. While the owner is at the Mac, an action push goes to the Mac only ([pushes go to the Mac only while the owner is at it](2026-10-30-1704-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md)).
- **prompt**: a background session's permission prompt or `AskUserQuestion` ([a background session's prompts and questions come to the phone](2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md)).
- **fault**: something only the owner can fix: a board that isn't listening, a session that didn't come back, and a production problem pushed with `--urgent`.

Everything else is news, found in the threads' unread marks and on the board: the answer to an ask, Claude's later lines in a thread whose push went, merges, a card going Stale, a morning digest, a new board's handshake, progress, cards reaching Done, approvals and builders finishing.

`hub/push.mjs` `deliver()` is the one gate. It takes the push's kind and refuses a push with any other kind, or none, so no skill can bring an information push back by accident. `board.mjs push` and `web-ts push` take `--kind action|prompt|fault` and refuse a push without one in one line, exit 2.

Questions, steps only the owner can run, prototypes, prompts and faults go at once; drafts on Ready and Merge go when their tick ends; all of them wait overnight for the first window's start ([pushes go out by kind, and each arrives on its own](2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md), [the hub polls GitHub and sends pushes on one polling interval](2026-10-29-1639-the-hub-polls-github-and-sends-pushes-on-one-interval.md)). `--urgent` bypasses the hold, but only for a critical production issue that someone messaged about. An owner question marked `urgent` shows alone on its page, but pushes like any other question.

The owner set the bar (round `site-v5`): urgent means a production problem worth waking up for, not a blocked build. The owner then narrowed pushes to these three kinds (`push-kinds` on hub/INT-146, take `action-prompts-faults`): "should only get notifications for things that cause the action needed badge to appear really … rest should be found via unread messages tag".
