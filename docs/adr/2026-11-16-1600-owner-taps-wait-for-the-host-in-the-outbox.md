# Owner taps wait for the host in the outbox

This supersedes the **Buttons that send wait** bullet of [a board out of reach keeps its copy or shows a landing](2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md), the waiting button of [a tap waits for the server to record it](2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md) for the taps listed below, and "There is no outbox" in [the hub's New task box files through the router](2026-11-16-0600-the-hubs-new-task-box-files-through-the-router.md). The rest of each stands.

The owner (T-420, 11/15): "I think we should no longer block buttons like implement, discuss, etc., when the server is not connected because it will still just go into sending. We have an outbox mechanism now, so let's leave the buttons always enabled and simplify that." The owner picked "All taps through the outbox, hold gone", with "Maybe just use the new section for now for anything that doesn’t fit in a thread". Then: "How long will it wait in sending?"

- **No button is held.** `ui.js` `SENDS`, `holdSends` and `WAITING` are gone, along with `style.css`'s `.offline :is(…)` rule. Offline, only the header time turns red. Every button stays live, and its tap goes in the outbox.
- **Every tap the board records goes through an outbox.** A card's thread taps (reply, Implement, Done, Reopen, Hold and Unhold, Merge, and the requests) already did this (`app-threads.js`). So did the questions sheet's answers and requests (`app-questions-sheet.js`). Now these join them:
  - the Block sheet's chip and Unblock, as `card-hold`, in the card's thread;
  - Merge, as `card-merge`, in the card's thread;
  - a card's bump and unbump;
  - an ask's delete (`ask-withdrawn`) and edit Save (`ask-edited`);
  - a review's Post it or Skip (`review-answer`).

  A tap tied to no card thread carries `said`, its row's words in the New strip: "Moved T3 to the top", "Unbumped T1", "Deleted: <text>", "Edited to: <text>", "Review of PR #437: Post it". Merge and the bump draw from their entry while it waits (`ui-snapshot.js` `tapped`: `merging`, `bumpedAt`), so a second tap can't send twice.
- **Still direct.** Settings saves, Main's retry, Serve, Build and Kill, Run a review, Check GitHub, hub prompts and a script offer's Run and Decline still send direct. They need an answer now, or must never send again after a reload, which the outbox does. Each toasts its error as before.
- **Sending lasts at most 15 s.** `ui.js` `sendWithin(send)` hands the send an `AbortController` signal and gives up after `SEND_LIMIT_MS` (15 s), rejecting with `timedOut`. `ClaudeSite.send` (`starter/public/claude.js`) passes the signal to its fetch. It marks a fetch that failed without an abort `unreachable`: nothing answered at all.
- **Out of reach, taps wait for the host.** A send that got no answer at all marks the link offline at once (`B.linkDown`). It stays queued with the taps behind it, reading "waiting for the host" (`ui-threads.js` `PICK_UP.held`) in its thread, its question's footer or its New strip row, as does any tap made while offline. When the link is back, `app-header.js` `setLink` calls `B.linkChanged`, which sends every queue again with no reload and no Retry. The link comes back when a board load lands or answers 304, from the poll, the change stream or the header's refresh. Waiting on you (`view-questions.js`) does the same with its own `online`, set by its loads.
- **Not sent is for an answer.** Not sent, with Retry and X, now means only one of two things: the board answered with an error, or the send had no answer in 15 s while the host looked up.
- **The hub's New task box has its own outbox.** `view-hub.js` keeps `{sendId, ts, text, files, fields?, uploads?, failed?}` in the page's store. A task's row leads the hub's New strip at once, reading sending…, waiting for the host, or not sent with Retry and X (X puts its text and files back in the box, `new-task.js` `reopenAsk`). The box's files move to the task's own box, and it posts once they are up. Tasks go one at a time, in order. A task leaves the outbox once the reload after its POST lands. `hub-kit.js` `live` reports reach through `linked(online)`, and the outbox sends again once the hub answers.
- **A resend never files twice.** `/_hub/route` takes the page's `sendId` (a plain token of up to 64 characters) as the request's id. `hub/router.mjs` `queueRequest` skips one already queued or routed, as a board's events POST dedupes a sendId.

Considered:
- holding only the buttons that can't queue: the owner wanted no hold at all, and every tap the board records can queue;
- not sent with Retry while out of reach, as before: the owner would retry by hand what the reconnect sends on its own;
- a longer limit than 15 s, or none: a phone that slept mid-request read sending… forever;
- review answers in the PR's card thread: a review belongs to a PR, which may have no card, so it reads in the New strip.
