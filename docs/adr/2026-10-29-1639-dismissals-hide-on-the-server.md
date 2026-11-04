# Deleting an ask hides it on the server, for every device

Deleting a pending ask or thread message writes its id to the site's `data/hidden.json` through `POST /api/hide` ([a pending ask or thread message can be deleted or edited, and a pending ask bumped](2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md)). Hidden events leave every list the page reads. The hide itself doesn't wake the session; the `ask-withdrawn` event sent with it does. Answered asks have no ✕ any more: they stay as Done items ([asks wait in a strip, then become Done items with their own thread](2026-10-29-1639-every-ask-is-a-card.md)).

At first dismissals were per device, in localStorage, on the grounds that work items were the durable store (round `site-v3`). The owner reversed that once they used the board on more than one device (owner ask, 2026-10-23).
