# Rules live on Settings, at hub and board level

A rule is a standing instruction from the owner to the sessions that own boards: one line of plain text, kept on Settings, which each session sees every time it wakes.

- **Shape.** A rule is `{id, text, by, at}`, where `by` is `owner`, or `claude` for one Claude codified on the owner's word. A rule is one line, at most 400 characters; line breaks collapse to spaces. `hub/rules.mjs` holds the rule logic.
- **Two levels.** Hub rules are `rules` in `~/.claude/web-ts/settings.json` and apply to every board. Each board's own rules are `rules` in its `board.json`, on top of the hub's. A write to either keeps every other key in the file.
- **The hub page** has an expandable "Rules for every board" row. Saving it writes `settings.json` and appends a `rules {scope: "hub", added, edited, removed}` event to every board site, so each owning session wakes.
- **Board Settings** is a modal with a Rules section for that board’s own rules, below Reviewers. Saving it writes `board.json` and appends a `rules {scope: "board", …}` event. Claude's replies to those events show under the section.
- **Both editors stage edits until Save**, as the Reviewers list does. Both use the same editor, `board/public/rules-editor.js`. A save sends the list it shows with the ids it loaded, so a rule added through the CLI after the page loaded stays. A rule Claude added reads "Added by Claude", also after the owner rewords it.
- **The watcher prints the rules with every wake.** After its `event` lines, `bin/wait-events.mjs` prints `rule hub <text>` for each hub rule, then `rule board <text>` for each of the board's. It prints nothing extra when there are none, and nothing on `handed-over` or `site-removed`.
- **The session follows them like the skill.** On a `rules` event it reads the printed list and says in one reply what it will do differently. When the owner says "codify" in a thread, it runs `board.mjs rules add --by claude`, at board level unless the rule is about every board (`--hub`).
- **CLI.** `board.mjs rules list | add | edit | remove`, with `--hub` for the hub's list.

The owner settled this in a grill on 2026-10-24. In the same grill, screenshots of UI changes stayed a skill rule (wave-build and join-web-ts), not a board rule: what holds for every use of a skill belongs in the skill.

See [hub settings expand in place and board settings open in a modal](2026-10-31-1721-hub-settings-expand-in-place-and-board-settings-open-in-a-modal.md) for the hub rows and board modal.
