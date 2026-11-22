# The hub page reads board events async, and only what was appended

On 11/22 the hub stopped answering for about 10 minutes while its boards answered at once. A stack sample put its main
thread in `readFileSync` inside a timer job, under a load average of about 25. Every hub page build called
`routedRows`, which read and parsed each board's whole `data/events.jsonl` synchronously: a scan of hub-orchestrator's
3.7 MB file took about 370 ms on an idle host, and far longer on a loaded one, all on the hub's only thread.

`routedRows` is now async. `readEvents` (hub/router.mjs) keeps each file's parsed lines and the byte offset past its
last whole line, and each read takes only the bytes past that offset, with `FileHandle.read`. The file only grows, so
a file that shrank or was replaced (another inode or birth time) is read afresh. Reads of one file queue, so two page
builds never parse the same bytes twice. A line cut off mid-write waits for its newline. The per-ask thread read
(`movedTo`) is async too.

Left alone: `readJSON` of the small `ask-links.json` and the board's items file, which are bounded by the card count,
not by the event history.
