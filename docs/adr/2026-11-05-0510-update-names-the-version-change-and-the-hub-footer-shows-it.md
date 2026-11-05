# `kickflip update` names the version change, and the hub footer shows the version

## Decision

`kickflip update` reads the installed package.json version before and after `npm i -g`. Changed: it prints
`0.4.1 > 0.4.2` and restarts the hub. Unchanged: it prints `no new version available` and does not restart, since
nothing changed on disk; the Hub page's Restart hub covers stale code.

`kickflip restart` with no route restarts the hub through its service, the same restart update uses. With a route it
still restarts that site.

The Hub page footer ends with `kickflip.sh / v0.4.2`: kickflip.sh links to https://kickflip.sh, and the version is
the running hub's own package.json, read once at hub start (`VERSION` in hub/hub.mjs) and carried by `hubView`.

## Why

The version read at hub start is the one the process runs; new files on disk run only after a restart, so reading it
per request would name code that isn't running. The hub's Upgrade runs update only when npm has a newer version, so it
always reaches the changed branch and its exit-status handling is unaffected.
