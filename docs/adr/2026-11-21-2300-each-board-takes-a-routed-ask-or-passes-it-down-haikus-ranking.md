# Each board takes a routed ask or passes it down Haiku's ranking

The router made one Haiku pick per request and filed it there; a wrong pick stayed until the owner or an orchestrator
moved it by hand (docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md). The card first
planned a same-repo shortcut ahead of Haiku; the owner dropped it: "Why not just always haiku? Have it check with the
orchestrator on whether or not the task fits, and go down the line."

Haiku now ranks the boards a request may belong to, best first, each with a reason, leaving out boards it clearly
doesn't fit. The ask is filed on the first with `routed.id` (the request's id) and `routed.next` (the rest of the
ranking). Its orchestrator either takes it at triage, as any ask, or runs `ask move <eventId> --next "<why>"`
(`board/asks.mjs passAsk`), which files it on the next ranked board, its routed carrying `passed` [{route, reason}], so
that board's thread opens "Passed on by /<board>: <why>" in place of "Routed here from …". Here the ask gets the
ask-moved line and its unstarted cards drop, as `ask move --to` does. `--next` takes the reason as its value: `--next`
is already a text flag on other commands, and the parser's bare flags are global.

Past the last ranked board the ask goes back to the hub: its line reads "Moved to the hub.", and its routed.json entry
turns `unplaced`. The owner chose (11/21) that Haiku then answers it itself, rather than it waiting on the hub for the
owner to place: the hub's tick (`hub/router.mjs answerUnplaced`) makes a second Haiku call, with no tools and so no repo
reading, from the ask's words and the boards' reasons for passing, and keeps the answer on the entry. A Slack ask's
answer also posts in its Slack thread, "🤖 " first as the orchestrator's Slack replies are. A failed call is tried each
tick up to `ROUTE_TRIES`, then the row shows why; a failed Slack post keeps the answer and says so on the row, without
retrying. The row keeps a plain board picker, so the owner can still put the ask on a board (`placeRow`, POST
`/_hub/api/place-row`), filed there with "you put it here after no board took it" as its routed reason.

routed.json is the one record of where a routed ask is now: its entry's `route` and `eventId` follow each pass, and
`hub/routed-log.mjs` holds its reads and locked writes, since both the hub (filing, answering, placing) and a board's
CLI (passing on) write it. The ranking itself rides on the ask (`routed.next`), so a pass needs nothing from the hub.

On the hub page's New strip a routed row whose board hasn't taken it (its card still New, not folded, not deleted)
reads an orange "Trying /<board>…" with each pass under it, and no X, as a waiting row has none. An unplaced row reads
"Answered by Haiku" (or "Haiku is answering…", or the red fault), the passes ("No board took this", folded to a count
past two), Haiku's answer in a blue reply block marked "Router · Haiku", that it went to the Slack thread too, the
picker and the X. A placed row links "Placed on /<board> …".

Left out: the boards on the owner's other hubs. The ranking covers this hub's boards only; filing an ask on a peer's
board, passing it back across hubs and returning it unplaced to the hub it came from would each need a new peer route.
