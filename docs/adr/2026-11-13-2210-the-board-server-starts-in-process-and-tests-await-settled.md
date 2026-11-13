# The board server starts in process, and its tests await settled()

`board/server.mjs` exports `startServer({site, home, port = 0, prefix, now, watch})` → `{server, changed(file), minute(), settled(), close()}`, and its script part calls it with PORT and PREFIX, the site's file watch as `watch`, and `minute` every 60 s. A test runs the server in its own process (`startBoard` in shared/test-helpers.mjs, on a port the OS picks) and drives it by state, not time:

- `changed(file)` stands for the watch reporting a write, so a test calls it after its write instead of waiting for macOS fs.watch, which can hold events back for seconds, batch them, or drop them on a busy Mac.
- `settled()` resolves once every pass a change, a minute or a request started has finished, those passes' own included, since the server tracks each pass it starts without awaiting it. A test awaits it instead of polling `/api/board` or waiting for the watch to go quiet.
- `minute()` is the minute's checks, for a test to run when it needs them.
- `now` is the server's own clock, which the frozen-Date `--import` setups stood in for; the store's functions still read their own.

With no watch in a test, the counts are exact: the server-builds tests assert one build and one signal, not a range that allows for a late event, so [the server-builds tests count after the watch goes quiet](2026-11-13-0926-the-server-builds-tests-count-after-the-watch-goes-quiet.md) is superseded. The first conversions are server-builds, server-merge, arch-review, done-archive, ticket-paths' server test and repo.test; server.test, server-stale and headless follow (docs/test-determinism-audit.md, F1a–F1c).

Some modules the server imports read HOME as they load (hub/boards.mjs, hub/prompts.mjs, hub/push.mjs), so a test file running the server imports shared/scratch-home.mjs first: HOME is a scratch folder for that file's process before any of them loads. A test that needs the server to read a different home's files resets that home's contents per test rather than pointing HOME elsewhere.
