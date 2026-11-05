# Record-only events do not wake the session

`bin/wait-events.mjs` used to exit on every new line in `data/events.jsonl`, so events the session answers with nothing (#180's audit, row 6) still woke it. Six kinds are now record-only: `main-pulled`, every `settings` event, `ask-done`, `reviewers-removed`, `repo-changed` and `ping`.

- **No exit.** A watcher whose only new lines are record-only keeps waiting.
- **The cursor moves.** `hub/boards.mjs oldestUnheard` reads lines past the cursor as unheard and drives the "isn't listening" push, so a held line left past the cursor would push early after a later deaf spell. The cursor advances past held lines at once and the lines are kept in the cursor file's `$quietHeld`, apart from `$usageHeld`, which `pending()` treats as wake-eligible.
- **Printed ahead of the new events.** The next wake prints the held lines first, in the order they came, each with its plain line, then the new events (owner, gh231-later: A). A line held while usage was paused moves into `$usageHeld` as before.
- **`main-pulled` always holds** (owner, gh231-main-pulled: C). The board rule that restarted the hub on it (#60) is gone; the hub restarts when cards land. Other devices run the hub from npm.
- **Every `settings` event holds** (owner, gh231-settings: A). The current values still print on every wake as `setting` lines.
- **`repo-changed` is record-only.** Builders launch headless from the manifest entry the hub already rewrote, and no page watches a reply to `repo-changed` or `settings`, so SKILL.md drops the "reply to acknowledge" step.
- **hello is a ping and ack** (owner, gh231-hello-2: hold; "This would be better described as a ping-ack"). The handshake's event kind is `ping`, the watcher's line reads `ping <id> from the hub answered`, `board/store.mjs ackPing` records the answer, and `data/handshake.json` is `{ping, ack, done_at?}`. The watcher answers a ping when it sees it, with no wake. A `hello` event and a `hello` key in an older handshake.json still read as a ping. The setup checklist's wording on the board page is unchanged.

Supersedes the "wakes the watcher" sentence in [the board server removes reviewers itself](2026-11-04-0119-the-board-server-removes-reviewers-itself.md) and the `hello` wording in [the board records what it knows](2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md).
