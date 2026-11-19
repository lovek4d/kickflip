# A tap's pulling note goes when the hub's pull does

The hub page showed a tap's answer, `pulling <latest>…`, whenever the hub's own pull state gave nothing to draw. After the pull installed, the hub reads `idle` on the old version until its restart (which waits while the hub is busy), so the page fell back to the tap's stale answer and kept reading `pulling` for as long as the restart took. A reload showed the hub's current state, which is why it looked like the page had missed the restart.

Now a tap's `pulling` answer is never the fallback: the hub's `update.pull` and its `version` are the only sources of pulling and `updated, reload`. Between the pull's end and the restart the row shows nothing, and the version change then turns it to `updated, reload` on the tapping page and on every other open one, as before.
