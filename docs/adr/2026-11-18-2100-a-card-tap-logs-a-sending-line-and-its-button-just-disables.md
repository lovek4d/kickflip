# A card tap logs a sending line, and its button just disables

Card #1061 (T-701). The owner (11/17): "would like to move towards all buttons logging and using that for the
sending... status, allowing us to just disable + quiet buttons on press instead of spinner them". An audit of the card
taps (visuals/T-701/button-audit.html) found some left no line in the thread: Bump and Unbump, a script's Run and
Decline, a Serve or Kill that the hub took, and a held card's Merge.

Amends [a sending card button spins, and the lane waits for the board](2026-11-17-1335-a-sending-card-button-spins-and-the-lane-waits-for-the-board.md):
its "The button waits" now reads as below. Its Action needed and lane rules stand. Also amends
[a sending tap spins in its status line](2026-11-18-0500-a-sending-tap-spins-in-its-status-line.md): the thread line's
spinner is now the only one, since the button no longer spins.

## Decision

- **Every card tap writes a line.** The board server writes the owner's line (`who: love`, a `command` from
  `domain.mjs` `COMMANDS`) for each tap that wrote none: `bumped` "Moved to the top" and `unbumped` "Unbumped" (tapPlan's
  `line` effect, with the tap's sendId), `merge` "Merge requested" on a held card (a card with a PR already gets
  "Merged PR …" or "Not merged: …"), `served` "Serve started" and `killed` "Serve killed" once the hub takes the request,
  and `script-ran` "Ran the script" and `script-declined` "Declined the script". A refused tap writes none.
- **Every card tap's sending… is its thread line.** An outbox tap already draws its line at the thread's foot, reading
  "sending…" with the spinner in its mark's place. The Bump now goes through its card's outbox, so its line shows in
  the card's thread rather than as a New strip row. A script's Run or Decline and a Serve or Kill stay out of the
  outbox, so a reload never sends them again: `app-threads.js` `postTap` draws their line, sending…, while the request
  is out, and drops it when the request is refused (or a Serve's busy-host question is declined, or the serve cap
  refuses it).
- **The button just disables.** A sending card button draws `ui.js` `SENDING`: disabled and dimmed as any disabled
  button, with no spinner and no `aria-busy`. That covers every button `BUSY` covered here, Merge while the board says it
  is merging, and a Serve, Kill, Run or Decline (`waitOn` and `spinUntil` take `quiet`). The bump's orange pulse is gone.
- **Controls with no thread keep their spinner.** The header, Board Settings and the hub have no card thread to log
  to, so they keep `BUSY`.

## Left out

A held review's Post it and Skip are on an Auto Review card, which has no thread: they keep their New strip row, which
reads sending… until the board has them, and the card's red failure line.
