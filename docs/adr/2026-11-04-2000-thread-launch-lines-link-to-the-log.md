# Thread launch lines link to the log instead of printing its path

A headless launch line is stored as "Builder launched headless on <model> in <worktree>." with a `log` field holding the log file's name. ui-threads.js renders the field as an "Open the log →" link to `log.html?file=<name>`, a page that shows the tail of the file and re-reads it every 3 seconds, so it works on the phone.

`GET /api/log?file=<name>.log` reads only a file of that bare name in `~/.claude/kickflip/logs`, so a path, `..` or another extension is a 400. It returns the last 256 KiB.

Lines written before the field existed end "; its log is <path>." domain.mjs threadOf reads such a path, when it sits under the logs folder, into the same field and drops the clause from the text, so nothing is rewritten on disk.
