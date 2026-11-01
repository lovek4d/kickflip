# A board has one ticket source

The owner settled `ticket-source`, `ticket-create` and `ticket-when` (A each) on hub/INT-184 and picked take A of `prototype-tickets.html`: every work card and follow-up has a ticket from its board's one source, Internal with a prefix, GitHub issues in the board's repo, or a Linear workspace, team and project.

- `board.json` `tickets` holds the source: `{source: "internal", prefix}`, `{source: "github"}` or `{source: "linear", workspace, team, project}`. Prefixes are 2–6 uppercase letters, INT when empty. New board's board details and Board Settings' Tickets row share one control; New board starts at Internal · INT.
- A card stores its ticket id as `ticket`, apart from its item id. A ticket id belongs to its source: the badge shows `PREFIX-n` (opening the card), `#n` (the issue) or `TEAM-n` (Linear, in the source's workspace) only when the id is from the current source. One stored under another source shows its own id, unlinked; changing the source never relabels it.
- A board with no setting badges as before: an internal wave's ref and a card's `linear` list.
- `item add` creates a ticket unless `--ticket` links one after checking it belongs to the source: Internal takes the next number, or an internal wave card's own id; GitHub runs `gh issue create` through an injectable runner. An ask gets none; `item set --from-ask` and `followup add` create one.
- Linear needs `--ticket` until the Hub's Linear key, issue creation, backfill and status sync arrive in phase 2.
