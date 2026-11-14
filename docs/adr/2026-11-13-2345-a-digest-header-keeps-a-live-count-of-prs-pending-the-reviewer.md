# A digest header keeps a live count of PRs pending the reviewer

The digest's header reads "<board> digest: N pending your review" and the hub edits it with `chat.update` as the PRs it counts leave review: approved, merged or closed on the hub's last GitHub read. At none it reads "<board> digest: all reviewed". The edit is signed off as every message is.

`review-digests.json` keeps `live` on the day's entry: the header's PRs, the count it shows, and for a digest that went into an open thread, the reply that holds the header with the text around the count. `review due` lists each header whose count differs; the hub edits it and records the new count. A failed edit leaves the message as it was and goes again next poll, so no static fallback header is posted.

A PR that fails its checks stays in the count: the digest listed it, and only leaving review takes it out.
