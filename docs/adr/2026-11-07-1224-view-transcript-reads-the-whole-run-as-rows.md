# View transcript reads the whole run as rows

#434. The owner asked to replace a run's raw log with a transcript: "Would like to replace subagent logs with transcript instead if possible, “View transcript” with a different visual maybe?"

Decision:
- The link at the end of a run's open section, and a message's log link, read "View transcript" (owner's wording). The sheet's title is "<role> transcript".
- The server turns the run's own stream log (headless.mjs, one stream-json event per line, in ~/.claude/kickflip/logs) into rows: `GET /api/transcript?file=<name>.log&from=<byte>` (transcript.mjs `readRunTranscript`). It reads from `from` to the last whole line and answers `next`, where the sheet's next read starts, so a live run is read on every 3 seconds without re-reading the file. The sheet used to read `GET /api/log`, the file's last 256 KiB, which dropped the start of long runs (logs reach 6 MB and more, about 94% of it each user event's `tool_use_result` copy of a tool's output). The rows take a call's output from `message.content` and skip that copy.
- The session's own transcript in ~/.claude/projects was the other source. The stream log was chosen as it is already in the board's logs folder for every run the board launches.
- The sheet keeps take A of the prototype (question gh434-transcript-look): Claude's words as plain rows, each tool call one tagged line (tool + command or file) whose output, cut at 4000 characters, opens on a tap of the line (▸/▾). An output arrives as a row `for` its call's id and joins that call's line. Thinking blocks in the stream are empty and an Agent call's subagent adds no messages to it, so neither has rows.
- The section's last line stays the link, with nothing live (gh434-run-section-last-line).
- The raw toggle and log.html stay the raw file, read through `GET /api/log` (its last 256 KiB).

Supersedes the reading parts of [a builder's log and notes open in a sheet](2026-11-04-2345-a-builders-log-and-notes-open-in-a-sheet.md): the sheet no longer turns the stream into rows in the browser, and it no longer re-reads the whole tail every 3 seconds.
