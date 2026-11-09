# Headless Chrome runs are retried once, then fail

Under the full suite's load Chrome sometimes crashes or never opens a page (#454, from #442). Two places run it, each with its own retry, since they share no launcher:

- `board/render-check.mjs` `launch()` tries `launchOnce()` again in a fresh profile when Chrome gave no port, page or socket. The second failure is a BoardError, "the render check could not start Chrome", not a raw TypeError. A take's reported problems are never retried, so a real question add survives a Chrome that fails to start under load.
- `board/prototype-phone.test.mjs` `phoneProbe()` runs Chrome again when no `<pre id="probe">` came back. The layout assertions run only on a probe that did, so they are never retried.

Land stays strict, with no automatic rerun of failed files (#442).
