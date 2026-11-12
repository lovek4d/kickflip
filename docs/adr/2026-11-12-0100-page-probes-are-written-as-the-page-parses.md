# Layout probes are written as the page parses, with no timer

`dumpProbe(file, width)` in shared/test-helpers.mjs runs headless Chrome with `--dump-dom` and reads the JSON an inline script at the end of `<body>` wrote into `<pre id="probe">`. The stylesheets sit in `<head>`, so that script already sees final computed styles, and every dump holds the probe: no `load` + `setTimeout`, no `--virtual-time-budget`. It reads stdout on any exit and runs Chrome once more when no probe came back. board/send-bar-snug.test.mjs and board/no-sideways-scroll.test.mjs use it (#545, from #512 and #454).

**Why.** Both fixtures wrote the probe 300 ms after `load` and read it with no fallback, so a Chrome that crashed, exited non-zero or dumped early under the full suite's load failed the test. The assertion on the probe is never retried.

**Not done.** `phoneProbe` in board/prototype-phone.test.mjs keeps its own retry and its 800 ms timer: its probe posts from an iframe of the served prototype page, which needs the page's scripts to have rendered.
