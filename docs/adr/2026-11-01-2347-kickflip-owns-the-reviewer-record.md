# Kickflip owns the reviewer record

A PR link sent to a reviewer is recorded on its wave item: `review_link_ts: {<reviewer name>: {ts, channel, reactions?}}`, with the DM channel and the Slack message timestamp. Board and wave reviewers remain `{name, slack_user, dm, github}`. Kickflip's session sends through Claude's Slack connector and records the result with `board.mjs review sent`; a merge adds `git_merged` through the connector, then records it with `review react`. Reactions are idempotent.

`board/review.mjs` is the one reader for the card's reviewer chips, review age and seven-day Stale lane, the hub's Slack link and the reviewer digest. It takes each reviewer's record from the item's `review_link_ts` first (also accepting a bare timestamp), then `review_sent` lists or maps, then the wave's legacy maps keyed by PR number or item key, then slack-bridge's topic files. It also owns topic-file reading. Existing waves keep their sent state without a migration or a required slack-bridge skill.

Slack identity is a hub setting in `~/.claude/kickflip/slack.json`, mode 600: `self_dm`, `owner_slack_user`, `slack_domain`, `timezone`. `hub/slack.mjs` imports slack-bridge's `state.json` config once when unset. `board.mjs slack` reads it and `slack set` updates it. The board no longer reads slack-bridge's unwritten `thread_ts` or shows a Slack thread row. It no longer reads monitor.json's unused wave `watched` flag.

`review digest` lists the PRs the hub's last GitHub check saw open, ready for review, passing and not yet APPROVED, as the board's review lane does; a PR the hub hasn't checked is left out. It includes an age only after 48 hours. It is due on weekdays from 09:00 in the Slack identity timezone (the host timezone when unset), once per board date. The session sends a top-level board summary and one thread reply per PR, then `review digest sent` appends `{reviewer, dm, ts, items, reactions}` to `data/review-digests.json` and sets `last_date`. A session completes the returned reviewer list even after recording the first send.

The card previously read topic items while the hub also read wave and item records: the hub could pass its Slack link while the card read unsent and never went Stale. Keeping sending in Claude's connector and the record in kickflip removes that split and the dependency on the owner's external skill.

Considered:
- continuing to write slack-bridge topic files: the board would still depend on an optional skill's storage and identity;
- keeping separate readers for the hub and card: every new record shape could split their state again;
- having the digest fetch GitHub: a read command would require network access and duplicate the hub's poll.
