---
status: superseded by ADR-0041
---

# One Improvements round covers the hub and every site

There is one Improvements round at a time, about the hub and every site. It lives on one board, the site `improvements_site` in `~/.claude/web-ts/settings.json` names (`ios-orchestrator` by default), with that board's existing machinery: its `public/grills/`, `grill.html`, its `grill-answers` and `brainstorm-improvements` events, and its owning session, which writes each round and acts on the answers. The cadence stays [0026](0026-the-next-improvements-round-waits-for-two-real-questions.md)'s.

Every page's header has the same bulb, the hub's home and Settings pages and every board's pages alike ([0021](0021-the-board-shows-github-checks-and-watcher-health.md)). Each reads `GET /_hub/improvements.json` (`hub/improvements.mjs`), which works out idle, ready or working from that board's files the way the board's own bulb did, and opens `/<site>/grill.html?g=<latest>`. An idle bulb asks to confirm, then sends `brainstorm-improvements` to that site's `/_claude/events`, so the round's owning session wakes, whichever page the tap came from. Hub Settings shows the same state and links to the earlier rounds on that board's Settings.

Each board had its own bulb and its own rounds, so a question about the hub or another board had no home, and the hub had no bulb at all.

Considered:
- a bulb on the hub only, with each board keeping its own rounds;
- separate rounds per site, each board's bulb opening its own.

The owner chose one shared round behind every bulb, with only the gear's target changing between the hub and a board (owner, question `int59-hub-settings`, option A, and `int59-hub-settings-2`).
