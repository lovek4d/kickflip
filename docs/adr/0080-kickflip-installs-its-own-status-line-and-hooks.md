# Kickflip installs its own status line and hooks

The owner picked option A of `setup-owner` on hub/INT-191, after dropping the status line and hooks from their dotfiles: kickflip sets up what it needs from `~/.claude` itself, so a public kickflip user needs no dotfiles.

- `bin/statusline.mjs` prints the old dotfiles line, directory, branch (`*` when dirty), model and context, plus Claude's usage (`5h 23% · 7d 57%`). After printing it saves the usage to `~/.claude/web-ts/usage.json` for the hub. It never fails the line.
- `web-ts install` links `~/.claude/statusline.sh` to it through the skill link of [0071](0071-kickflip-runs-from-a-linked-clone.md), and sets `statusLine` in `~/.claude/settings.json` only when there is none. It replaces a dangling link or a site's prototype, and refuses a real file or another working link.
- The Codex share reminder joins builder-stop in the `web-ts-hooks` plugin, so no hook goes into settings.json and the owner's other hooks stay.
- Install drops a settings.json hook entry that runs the old `~/.claude/hooks/no-paths.py` once that file is gone.
