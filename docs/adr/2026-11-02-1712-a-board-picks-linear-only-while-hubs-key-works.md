---
status: superseded in part by 2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source
---

# A board picks Linear only while Hub's key works

`settings set tickets` and `ticket` lines for the Linear MCP without a key are superseded by [every new card gets a ticket in the board’s current source](2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).

The owner asked on hub/INT-253 to "reject opening board linear without a working linear key", with a link to where the key is made and dropdowns in place of free text, and settled take A of prototype `linear-gate-2`: "Key modal on top". This supersedes in part [kickflip reaches Linear with a key on the Mac](2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md), whose Tickets control took a typed workspace, team and project without a key.

- **The gate.** Board settings and New board pick Linear for a board's tickets only while Hub's Linear key works. Tapping Linear without one opens Hub's Linear key modal over the page, with no confirm and no navigation (`board/public/linear-key.js`). Once a pasted key works the modal closes, Linear is picked, and its Team and Project dropdowns load. Closing it without a working key leaves the source as it was. The typed Workspace, Team and Project fields are gone. A board already on Linear whose key is missing or refused keeps its source and says why, with a button that opens the same modal.
- **The hub remembers a refused key.** `~/.claude/kickflip/linear.json` gains `refused_at` when Linear refuses the saved key on any call, and loses it when a later call with that key gets an answer. A pasted key that Linear refuses is saved with `refused_at`, replacing the key before it, so Hub settings shows "Doesn’t work · Linear refused the key" with Remove. `linearStatus` reports `refused`, so the gate, Hub settings › Linear and Integrations know before a board lists teams; `/_hub/api/linear` answers a refused key without calling Linear. Other failures, such as Linear being unreachable, save nothing.
- **Autosave.** The key saves and is checked on paste, change or Enter, showing "Checking the key with Linear…". Board settings › Tickets saves each pick at once, showing "Saving…" then "Saved"; a text field saves on change or Enter. There are no Save buttons there. Done, ✕, Escape and the backdrop wait for a save in flight, Done showing a spinner, then close.
- The key link goes to https://linear.app/settings/account/security and shows only while there is no key or Linear refused it. The Hub › Linear note reads "A board can pick Linear for its tickets only while this key works."

`board.mjs` still works without a key as [kickflip reaches Linear with a key on the Mac](2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md) says: `settings set tickets` takes a typed source, and `ticket` lines ask the session to use its Linear MCP.

Considered:
- A confirm, then Hub settings › Linear (`linear-gate` take A): leaving Board settings to paste a key, then tapping Linear again, was two trips for one choice.
- Refusing a pasted key without saving it: the hub could not show which key failed or offer Remove, and a later revocation would look the same as a key that still works.
- Stopping all calls once a key is refused: a brief refusal from Linear would stop the poll's moves until the owner pasted the same key again.
