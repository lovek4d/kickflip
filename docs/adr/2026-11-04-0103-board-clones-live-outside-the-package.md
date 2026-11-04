# Board clones live outside the package

The hub kept board repo clones in `<clone>/.repos` when kickflip ran from a git clone and in `~/.claude/kickflip/repos` when it ran from the npm package. On 11/03 a host switched from the npm install to `npm link`, and a board start broke. Retry kept the first attempt's repo path. The clone went to the new base, but the session started on the old path, `isClone` failed against the new base, and the trust step was skipped ("Workspace not trusted"). The old clone under `~/.claude/kickflip/repos` was left unused. A board's `owner.repo` had also been stored as `~/.claude/skills/kickflip/.repos/…`, which only resolves while that link points at a clone.

**Board clones live in `~/.claude/kickflip/repos` in both modes.** `reposDir()` in `shared/repos.mjs` returns `<home>/.claude/kickflip/repos` whatever the running root is, so switching between the npm install and a clone keeps every clone where it is. A path under it is outside the package, so `storedPath()` stores it as its real path, and it never goes through the skill link.

**Retry takes the clone path again.** `retryBoard` in `hub/new-board.mjs` recomputes the Starting record's `repo` from its repo and the current clone home, so the session starts in the folder the clone goes to, and the trust step sees it as a hub clone.

**Doctor lists clones in old places, and `--fix` asks about each one.** The old places are the running root's `.repos` folder and any `.repos` folder holding a repo that the manifest records for an open, closed or starting board, followed through links to its real path. A folder there with a `.git` entry is a clone. Doctor lists each clone as `old board clone`, marked optional so it doesn't fail doctor, and names the boards whose repo is in it. In a terminal, `doctor --fix` asks `Remove the old board clone <path>? (y/N)` for each one, saying which boards use it, and removes only the clones answered yes. `--json`, no terminal and `--dry-run` remove nothing; `--dry-run` prints the clones it would ask about.

Considered:
- storing clone paths by real path and keeping the two bases: an npm-to-clone switch would still strand every clone in the old base and clone the repo again.
- moving old clones into the clone home: boards and builder worktrees record the old paths, so a move would break them as surely as a removal, and the owner asked for doctor to offer removal.
- marking old clones fixable: a clone the owner chooses to keep would fail doctor every run.
