---
status: accepted
---
# Board Settings picks which build script a board runs

Amends "one fixed script" and the considered "owner-set script path" in [a board's build script serves or builds each card and main](2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md).

One repo can have several build targets: a web front end served with a dummy user and an iOS app, say, each wanted on its own board. The owner chose a Board Settings picker over a board-to-target map file in the repo and over a free-text setting passed as an env var.

- **A target names a repo script.** board.json's `build_target`, absent by default, names `.kickflip/build-<target>`: letters, digits, `.`, `_` or `-`, starting with a letter or digit. With none the hub runs `.kickflip/build`, so existing boards keep working. The script stays a reviewed repo file; the setting picks among them, it is not a path.
- **Everything else about a run stays.** The hub runs the target's script with the same arguments (`<key>` or `main`, then the worktree), cwd, env (`KICKFLIP_BOARD`, `HOST=127.0.0.1`) and the same ownership, mode and inside-the-worktree checks. A card's script presence in `data/try.json` and main's eligibility check the target's script, on the card's branch and at main's tip.
- **Main builds the board's target.** Main's entry in `data/try.json` records `target` when one is set, and a target that differs from the board's rebuilds main at the same tip within one tick. Cards rerun only on the owner's Serve or a new head under Auto serve. "The last finished run decides the board's kind" stays stable because each board runs one target.
- **The picker lists what main has.** Board Settings' Build target, under Repo, offers Default and every `build-<target>` with mode 100755 under `.kickflip/` in the git tree at the ref main builds from (`GET api/build-targets`). A saved target the tip no longer has stays listed as "<target> (not on main)", and a repo change lists the new repo's scripts. A pick saves at once through `POST api/settings` and sends the session a `settings` event, `build_target: null` for the default. Its subtitle and main's failure sheet name the script that runs. `board.mjs settings set build-target <target>|default` sets it from the CLI.
- **Saving checks the name only.** A target with no script fails its run through the existing script checks, which now name the missing file.

Considered:
- a board-to-target map file in the repo: the owner wanted the choice in Board Settings, next to the board's other run settings;
- a free-text setting passed to `.kickflip/build` as an env var: one script switching on it hides which builds exist, while separate scripts list themselves in the picker.
