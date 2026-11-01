# Codex share follows whether Codex is usable

The owner settled `codex-usable-2` A on hub/INT-205: Codex share is Auto when Codex is usable and nobody chose, and Off, greyed out, while Codex can't be used, so a new hub uses Codex without a visit to the Usage card and never hands work to a Codex that can't run.

- Codex is usable when it is installed, a `codex` executable on the PATH, and logged in, `~/.codex/auth.json`. Running out of usage doesn't count: Auto already hands work to Opus until the reset. `shared/codex.mjs` `codexStatus` is the one check; it looks for the file and never runs `codex`. The hub, `kickflip codex-share`, the codex-share hook and `kickflip doctor` all use it, each against its own PATH.
- The setting in effect is Off while Codex isn't usable, whatever is stored; else the stored choice, or Auto when none is stored. `push.mjs` `readCodexShare`, the CLI and the hook all read that, so sessions see Off while Codex can't run. The stored value is kept, so a choice made earlier comes back once Codex is usable again.
- While Codex isn't usable, a change is refused, from the Hub page (409 with the fix) and from the CLI, so nothing is saved that would surprise later.
- The Usage card's Codex block opens with the Always on / Auto / Off control, with no caption above it; Codex's 5-hour and Week bars sit under it, and with share Off the block is only the title and the control. Not usable, the control is disabled on Off, the title's tag says Not installed or Not logged in, and in place of the description the reason and the command to run: `brew install --cask codex` or `codex login`.
- The hub keeps the PATH lookup for a minute, since the sidebar polls often, and looks again before saving a choice; the login is checked on every read.
