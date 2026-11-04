# Kickflip is the only name

The owner picked option A of `cli-rename-scope` on hub/INT-198: every name that said web-ts says kickflip. The CLI is `bin/kickflip.mjs`, live state is `~/.claude/kickflip/`, the skill link and its command are `kickflip`, the hooks plugin is `kickflip-hooks`, the hub's login item is `local.claude.kickflip-hub`, and environment variables start with `KICKFLIP_`. No other hub runs under the old names, so no code reads them except one move of this Mac:

- `migrateHome()` in `bin/install.mjs` renames `~/.claude/web-ts` to `~/.claude/kickflip` while only the old folder exists, and leaves a link at the old path. It adds `skills/kickflip` beside `skills/join-web-ts` on the same clone, links `kickflip-hooks` and removes `web-ts-hooks`, since two links to one plugin load its hooks twice, and points `~/.claude/statusline.sh` through the new skill link. A rename keeps open files and watches working, and the old links keep saved paths, manifest commands and running sessions' commands working, so no stored path is rewritten.
- `install` runs it first, then swaps the login item: it stops the old label, removes its plist and starts the new one, and puts the old one back when the new one won't start. `install --dry-run` prints these steps without making them.
- The hub, `board.mjs`, `kickflip.mjs`, `wait-events.mjs`, the status line and the builder-stop hook run it as they start. After a land, whichever runs first must move the folder before anything creates `~/.claude/kickflip`; two folders would leave the new code without the manifest.
- `bin/web-ts.mjs` runs the CLI for sessions that loaded the skill under its old name.

## Update 2026-11-03: the migration is removed

hub/INT-204 (#8) removed `migrateHome()`, its start-up calls, the old login-label swap in `shared/service.mjs` and the `bin/web-ts.mjs` shim. Every host now runs under the kickflip names, and the moved host's saved paths in the manifest, builder records and site pages were rewritten once to `~/.claude/kickflip` and `~/.claude/skills/kickflip`, so nothing reads the old names.
