# Boot lists replies/ once and skips Done cards' agent files

#802. docs/adr/2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md measured a board server's boot and named two reads it could do without: withReply's readdir of `replies/` once for each needs-reply event, and every `agents/*.json`, finished builders' included.

## Decision

- A snapshot lists `replies/` once (store.mjs readReplyIndex, a Map from event id to its reply files) and hands the index to withReply. Calls outside a snapshot, such as a thread's events, still list the folder themselves, and replyFilesOf is the index's lookup for one event.
- liveFiles reads no agent records of a card whose lane is `done` (store.mjs readAgents takes the ids to skip). The card's detail still reads its own records.

Nothing is kept between snapshots, so a reply or a card moved out of Done is read by the next one.

## Measured

On /hub-orchestrator's real data folder, 3,266 needs-reply events, load 7–8 on 10 cores, so **provisional**:

| Read | Before | After |
|---|---|---|
| listing `replies/` for the events (bare readdir per event, without withReply's name matching) | 226 / 261 ms | 1 ms |
| agent records | 940 files, 18 / 20 ms | 832 files, 11 / 13 ms |

## Cost

A Done card's builder records no longer count toward checksOf's claudeAt (the newest write of Claude's the board can see) or the card's handedBackAt, limboFrom and writes. A Done card's thread lines still do.
