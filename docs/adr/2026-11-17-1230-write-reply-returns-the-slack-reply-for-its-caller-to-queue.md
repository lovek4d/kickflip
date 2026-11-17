# writeReply returns the Slack reply for its caller to queue

`asks.mjs` writeReply used to import slack-store.mjs to queue a reply to a Slack-sourced event, which put Slack in the
ring of modules importing each other (slack-store imports cards and settings; asks imported slack-store).

writeReply now returns `{ file, lines, slack }`, where `slack` is `{ key, name }` for a reply to post into its Slack
thread (a Slack-sourced event on a card that is not Done) and null otherwise. The CLI's `reply` queues it with
slack-store's queueSlackReply. `slackSourced`, a pure test of an event, moved to domain.mjs.

Not done here: turning setItem's calls into questions, asks and runs into a returned plan, as tapPlan did for taps.
That would end the rest of the ring and is its own card.
