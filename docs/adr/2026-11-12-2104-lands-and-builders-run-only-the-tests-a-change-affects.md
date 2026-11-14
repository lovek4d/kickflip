# Lands and builders run only the tests a change affects

Supersedes the "full suite" wording of 2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md and 2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md: a land, a pull-request push, a builder and a rebase run each run the test files the change affects, not every test file. Their time limits, process-group kill and concurrency cap (2026-11-12-1600-the-test-runner-caps-concurrency-to-half-the-cores.md) are unchanged. The full suite still runs at release (.github/workflows/release.yml); the nightly full run is T-268's, which places it in the overnight window.

**The selection** (board/affected.mjs `affectedTests(dir, base)`): the changed files are `git diff --name-status -M <merge-base>` plus untracked files, so commits, uncommitted edits and new files all count. A test file's computed set is every repo file it reaches:

- the files a module imports by a relative specifier;
- the repo files a test or an HTML page names in a quoted string: each string alone, each run of comma-separated strings joined (`path.join(root, 'hub', 'hub.mjs')`), resolved from the file's folder and from the repo root; a `./` or `../` string naming a folder names every file in it, and a template counts up to its first `${}`, so `` `./public/${file}` `` names public/;
- the files board/test-map.json's `paths` adds for a module that builds a path at runtime (the board fixture runs board/bin/*, board/server.mjs and hub/shell.mjs serve board/public, the hooks installers name hooks-plugin).

A shipped module's other quoted paths are not followed: code that stores or serves a path doesn't run it, and following them made nearly every test reach nearly every file (bin/install.mjs names hub/hub.mjs only to store its path). A change runs each test whose set holds a changed file, plus the map's `core` (the selector's own tests and the runner's).

**The full suite runs instead** when package.json, the lockfile, .github, the selector or its map, or a `full` file of the map (the shared fixtures board/board-fixture.mjs and shared/test-helpers.mjs) changes; when a file is deleted or renamed; or when a changed file reaches no test. A markdown file no test reaches needs none: every card writes an ADR, and a test that reads a markdown file names it.

**The guard** (board/affected.test.mjs, in the core so every land runs it): each repo file a test names in a quote, by a path or a bare name only one repo file has, is in that test's set. A test that reaches a file through a path built at runtime fails it until board/test-map.json names that path. The few names a test quotes that aren't that repo file (a scratch file of the same name, a URL a server is checked to refuse, words in a title) are listed in the guard.

**The wiring:** `nodeTests` takes the file list; `affectedRun(base)` (board/worktree.mjs) selects and says which run in one line ("testing the 12 test files the change affects", or "testing every test file, as package.json changed"). `prepareLand` runs it against the board's branch, a pull-request push against origin's, and `board.mjs test [--dir] [--base]` runs it for a builder, whose brief now gives that command in place of `node --test`.

**What it saves, measured on main's last 40 commits** against this branch's graph of 129 test files: the selection ran 4 to 104 files, typically 56 to 104, and the full suite for 4 commits (a package file or the selector changed, or a file was renamed). The import graph is dense: board/domain.mjs is reached by 86 test files and board/public/* by about 55, through the servers that serve it. Selection alone cuts a typical land by about a third; the rest of the time is in the heavy files the T-254 trimming cards take on.

Since #695 a builder runs only the tests it writes or changes, the land runs the affected set once after its rebase, and In Progress has four steps, testing gone ([builders run only their own tests; the land runs affected once](2026-11-14-0600-builders-run-only-their-own-tests-and-the-land-runs-affected-once.md)).
