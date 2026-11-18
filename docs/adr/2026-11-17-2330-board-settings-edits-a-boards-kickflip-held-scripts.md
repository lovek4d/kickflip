# Board Settings edits a board's kickflip-held scripts

The second part of T-673, after [a board's scripts live in its repo or in kickflip](2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md): Board Settings picks where the scripts live and edits kickflip's copies.

- **Scripts source.** Board Settings' Scripts section is a Repo | Kickflip switch under Build target. A tap saves at once through `POST /api/settings {scripts}`, as `settings set scripts` does.
- **Repo hides.** The Repo choice shows while main's `.kickflip/` has any executable build, `build-<target>` or release (build-script.mjs `listRepoScripts`), or while the board runs its scripts from the repo, so the switch always shows what runs. The owner asked to hide the repo choice when the repo has no scripts; a board on the repo default with none still shows it pressed, beside Kickflip.
- **Code boxes.** While the source is kickflip, each of its scripts is a code box with Save: build and release always, empty until written, and each `build-<target>` in the site's `scripts/` (`kickflipScripts`). Save sends `POST /api/scripts {name, text}`, which calls `writeScript`: a save replaces the file, with no history. Add build target opens an empty box for `build-<target>`; the file exists once saved. An unsaved box marks the section dirty, so the shell asks before closing.
- **What follows the source.** Build target's subtitle names the home that runs (`.kickflip/build` from each task's branch, or kickflip's `build`), and a source move or a save lists the build targets and Run release script's switch again, since both read the source's scripts.
- **No event.** A script save wakes no session: main rebuilds from the script's mtime (try.json `saved`), and the board's session reads the file when it runs.

Considered:
- Code boxes while the source is repo too, to write kickflip's copies before switching: rejected for one place to edit what runs; a board switches, then writes, as onboarding's scripts card does.
- Hiding Repo even while it is the source: rejected, as the switch would then show neither choice pressed.
