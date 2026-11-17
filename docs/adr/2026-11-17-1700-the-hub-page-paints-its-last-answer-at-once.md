# The hub page paints its last answer at once, and sends wait for the live one

T-423 part 1. The hub page showed "Loading" until the host answered, while a board page already paints its saved copy.

## Decision

`HubKit.live` saves each live answer in `BoardUI.pageCopy`, under the answer's URL, as `{build, data}`, with the saving page's build (`app.html` `data-build`). On open it reads that copy and paints all of it at once when its build is the page's own; the header's time then says how old it is. The live answer paints over it. A failed first load paints "Offline" only when no saved answer is showing.

A copy from another build is ignored: code from another build may read the answer's shape differently, and a paint that throws stops the live load, as with the board's copy (`readCopy`).

**Sends wait for the live answer.** The hub page's outbox holds its sends until the first load has answered or failed, and `HubKit.holdUntilLive` refuses every other button, checkbox, select and form submit under the page until then, with a toast, so a control added later is held without anyone listing it. A short list of reads is let through: the header, the New task box, the buttons that only open or close a sheet or Settings, disclosure toggles and links. A saved copy can be older than what the host holds (a request the hub already listed, a changed setting), so nothing is sent or changed off it. Until then an outbox row reads as held.

Served pages' copies are the worker's, a separate task (T-616).
