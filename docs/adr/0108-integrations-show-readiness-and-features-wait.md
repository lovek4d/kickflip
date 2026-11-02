# Integrations show readiness, and features wait until theirs is ready

The hub page has its own Integrations section between Health and Boards, as settled in take A. Its rows are GitHub, Codex, Linear, Slack, Tailscale and Notifications, in that order. Ready is green and says what was checked. Not ready is orange attention, following [0096](0096-colour-says-whos-waiting.md), and says what is missing, the command or settings link that fixes it, and which features wait.

`hub/readiness.mjs` owns the checks’ words and the features’ waiting words. The page, `board.mjs integrations` and feature gates read the same rows. It reuses the existing GitHub login, Codex status, Linear key, doctor’s Tailscale checks and push settings and subscriptions. Process probes for GitHub and Tailscale are cached for a minute; file-backed checks are read each time. Snoozing pushes or holding them on weekends leaves Notifications ready.

The hub cannot see Claude’s connectors. Each board session reports Slack yes or no at session start with `board.mjs integrations report --slack yes|no`; the latest report in `~/.claude/kickflip/integrations.json` carries its time, route and site title. The row says who reported and how long ago. No report means not ready.

Reviewer DMs, reactions and digests wait while Slack is not ready and leave their records unchanged; a digest answers `due: false` and the waiting reason. Try builds refuse with that reason and 409 while Tailscale is not ready; automatic main builds wait quietly. Linear moves already wait without a saved key ([0107](0107-the-hubs-poll-moves-the-owners-linear-tickets.md)), and Codex share stays Off while Codex is unusable ([0092](0092-codex-share-follows-whether-codex-is-usable.md)).

Considered:
- Integrations inside the Health card (take B): a section of its own makes the prerequisites and their waiting features easier to find.
- Probing Slack from the hub: it cannot see Claude’s connectors; a board session reports what it can use.
- Per-feature checks: duplicated checks and words drift from the hub’s explanation.
