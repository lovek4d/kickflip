# The app reloads for new hub code only on the owner's tap

An open app shell keeps the scripts it loaded, while the hub's `/_hub/api/*` answers change shape between commits. The Home Screen app resumes from memory, so a shell can run for days against a hub restarted on newer code and misread it, as when an old Hub page read Codex as logged out after a renamed field. The owner settled on hub/INT-219 that the app offers a reload and never reloads by itself, and picked the sidebar take of the reload-banner prototype.

- **The hub's code identity** is the hash it records as it starts (`hub/boards.mjs` `recordHubCode`, `~/.claude/kickflip/hub-code.json`), the same hash the hub link compares. The hub sends it as `code` in `/_hub/sidebar.json`, so in the shell's inlined sidebar data and every `sidebar` event on `/_hub/stream`, and as the `X-Hub-Code` header on its JSON answers.
- **The shell compares.** It remembers the hash it booted with, from its inlined data or its first `/_hub/sidebar.json`; a shell that booted from this device's stored copy takes the first hash it hears. A different hash later, from the stream, a sidebar fetch or a hub view's data before that view paints, shows the New version row. Nothing reloads by itself, so an unsaved edit, an open sheet or a half-written reply is never lost to a deploy.
- **The New version row** sits at the top of the sidebar, above Hub, styled like Turn on notifications in the accent colour, inside a `role="status"` region that persists across repaints. It never takes focus, and while a modal sheet is open it waits behind it. On a phone with the drawer closed, or with the rail collapsed, a plain dot with no number sits on the page logo, whose label reads "Boards, new version ready".
- **Reload** shows Reloading… on the row, asks the service worker to forget its saved shell, and reloads the page, which keeps the board in the URL and the open cards this device stores. With no saved shell to fall back on, that load waits for the network, so a slow hub can't hand back the old shell after 3 seconds; the new answer is saved as usual. New shell files carry new `?v=` versions, so no old saved file answers for them.

Considered:
- reloading by itself when the hash changes, which loses unsaved work and moves the page under the owner's finger;
- a strip at the top of the page's content, or a floating bar beside the + button (the prototype's other takes);
- naming the cache after the hash, which the worker sees only after the reload it would have to answer.

A change to the shell's own files that leaves the hub's code unchanged shows no row; the next load picks it up.
