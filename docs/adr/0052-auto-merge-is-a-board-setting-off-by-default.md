# Auto-merge is a board setting, off by default, and the owner merges from the card

Whether monitor merges an approved PR on its own is a per-board **setting**, `auto_merge` in the board's `board.json`, not a rule ([0039](0039-rules-live-on-settings-at-hub-and-board-level.md)). It is off when absent.

- **Off (the default).** Once a card's PR is approved, CI is green and its merge state is CLEAN (`board/domain.mjs` waits on `merge`), the card gets the owner action `{kind: "merge", label: "Merge"}`: Action needed in In Review ([0045](0045-the-lane-follows-who-acts-next.md)) and a Needs you line. The open card's action row leads with **Merge**, which confirms like every card button ([0023](0023-a-card-can-be-held-and-every-card-button-confirms.md)) and sends `card-merge {key}`. monitor merges on that event with the same checks as before (approved, green, clean, commits after the approval).
- **"Merging…"** shows, disabled and with no Action needed, while the latest `card-merge` for the card is newer than its newest Claude thread line other than a status line. The PR merging moves the card to Done; a session that can't merge says why in one thread line, which brings Merge back.
- **On.** No owner action; monitor merges once the PR is approved, green and clean, as it did before.
- **Manual steps** keep their own `steps` action either way: monitor never merges those on its own.
- **Where it is set.** The board's Settings page has an "Auto-merge approved PRs" toggle, which confirms before turning on. It saves through `POST api/settings`, which writes `board.json` itself, so the change holds with no session awake, and appends a `settings {auto_merge}` event when the value moved. `board.mjs --site <route> settings` prints the settings as JSON, and `settings set auto-merge on|off` writes them.
- **Every wake carries it.** After the `rule` lines, `bin/wait-events.mjs` prints `setting auto-merge on|off`.

The owner asked why a PR wasn't merging on its own. A session had held it on a "merge needs Love's go" rule the owner never set, while another merged approved PRs without asking: free-text rules and habits were read differently by each session. A boolean the board shows, and that every wake prints, means the same thing to every session, and the board can act on it, such as by showing Merge.

The owner asked for an auto-merge option in each board's Settings, default off (Shipyard session, hub/INT-120).

Considered:
- a rule ("merge approved PRs yourself"), which the board can't read, so cards couldn't show Merge, and which sessions had already read in different ways;
- default on, today's monitor step, which merges while the owner may want to try the build first.
