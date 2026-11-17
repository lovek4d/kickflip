# Served pages open from the worker's copy

Learn and the other framed sites (`dir`/`port` sites, a board's prototype pages) opened from the network only, so with the Mac asleep their frame stayed blank. The owner picked the hub's service worker to keep them, over each page keeping its own (T-423).

`hub/sw.js` now answers a frame's page load (`Sec-Fetch-Dest: iframe`) and a site's own scripts, styles, images and fonts network first, as it does the shell: the network's answer replaces the copy saved under that full URL, and the copy answers when the network fails, answers a 5xx or takes over 3 seconds. Only an OK `text/html` answer that isn't the shell is kept as a page. API calls, `_claude/` events, `uploads/`, `/_hub/` files outside the shell's, posts, other origins and `?alone=1` still go to the network only.

- A page never opened before still fails as before; one visit is the way to get a copy.
- A site's copy of one path keeps only the last URL opened (a prototype's `?take=` replaces the previous), as the shell's files keep one `?v=`.
- The frame shows the copy as is. It does not reload when the live answer differs, so a changed page shows on its next open; a reload from view-frame.js was not built.
