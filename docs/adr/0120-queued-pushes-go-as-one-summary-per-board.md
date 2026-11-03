# Queued pushes go as one summary per board

The owner asked on hub/INT-214, after a weekend's hold sent 40 queued pushes at once and 11 more at the Monday 8am slot: "Summarize and dedupe them, at least by card or work item, and maybe more broadly. Sending them all at once is janky." Each card's push already replaced its older one by tag, so the 40 were 40 different cards, asks and prompts. This replaces "How several arrive" in [0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md).

- **One summary per board.** Every flush of the queue (the slot poll, Send now and `board.mjs checked`) groups the queued pushes by the board their url opens, `/<route>/…`, after keeping the newest of each tag. A board with one push sends it unchanged. A board with 2 or more sends one summary instead (`hub/schedule.mjs` `notifications`, owner `push-group` A and `push-when` A).
- **It says what waits now.** The summary reads the board's Needs you at send time, from the `/_hub/needs.json?fresh=1` answer `hub/push.mjs` `flushQueue` fetches once per flush: "3 need you on ios" over the board's summary line, opening `/<route>/`, where Needs you sits at the top ([0043](0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)). A board with nothing waiting by then sends nothing, and its pushes leave the queue (owner `push-says` A).
- **A board that doesn't answer gets the queue's words.** When the hub doesn't answer, or lists the board as `null`, the summary is "N updates on <route>" with the first two titles.
- **A newer summary replaces the older one.** Each board's summary carries the tag `summary:<route>`, so `hub/sw.js` shows it in place of the last one, with `renotify`, and only the latest stays on the device.
- **It reaches as far as its widest push.** A summary holding a prompt or fault goes to every device; one of action pushes only follows [0065](0065-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md).
- **A failed send keeps its pushes.** The queued pushes behind a summary no device took go back to the queue, as a single push's does.

Urgent pushes and `--now` pushes outside a hold never queue, so they still arrive on their own. A burst of `--now` pushes after a usage resume ([0094](0094-work-pauses-at-the-pause-line.md)) is outside this.

Considered:
- one summary for the whole queue, across boards;
- no summary, only dropping pushes whose card no longer waits;
- a summary built from the queued titles, rather than the board's Needs you;
- summarizing only after a hold or Send now, not on every flush.
