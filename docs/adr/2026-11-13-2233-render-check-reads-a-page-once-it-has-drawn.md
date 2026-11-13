# The render check reads a page once it has drawn

Before a prototype question publishes, board/render-check.mjs loads each take (or a served round's page) in headless Chrome and refuses one that throws, logs an error, or draws nothing. It decided "draws nothing" by polling the stage every 100 ms for up to 3 s, then waited 300 ms more for late errors. On a loaded host a take that drew after 3 s was refused as empty, and an error after the 300 ms was missed.

It now waits on the page instead of the clock:

1. Chrome's load event (`Page.loadEventFired`). Every script in the page has run.
2. For a take page, the kit's `PrototypeKit.drawn` (board/public/prototype-kit.js), which resolves once the first take has drawn or failed. Load alone isn't enough: the kit draws a take after a dynamic `import()` of its file, which the load event doesn't wait for. Measured in headless Chrome, the stage was still empty at the load event every time. A served page has no kit and is read at its load event.
3. One task later (a page-side `setTimeout` with no delay), so an error the drawing left unhandled, such as a rejected promise, is reported before the stage is read.

The stage is then read once. What changes on any host: a take that draws later than its render returns, from a timer or a later fetch, is refused as empty, where before it had 3 s; an error after the take has drawn isn't caught; and a page that never fires its load event, or a take whose render never settles, holds the check until it is stopped, where before it gave up after 3 s. Chrome's start (the DevTools port and page polls) and a served round's port and answer waits keep their limits.
