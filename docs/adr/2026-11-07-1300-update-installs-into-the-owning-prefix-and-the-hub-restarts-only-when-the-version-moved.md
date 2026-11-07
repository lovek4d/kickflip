# `kickflip update` installs into the npm prefix that owns the running install, and the hub restarts only when the version moved

Status: accepted (#427)

The hub once restarted about every 10 seconds. `kickflip update --no-restart` ran the PATH's npm, which wrote 0.6.1 into Homebrew's prefix while the running install (nvm) stayed at 0.6.0. The update exited 0 with "no new version available", the hub took exit 0 as a pull and restarted, and the next start saw npm ahead again.

- `update` runs `npm i -g --prefix <prefix> @lovek4d/kickflip@latest`, the prefix being four folders above the install (`<prefix>/lib/node_modules/@lovek4d/kickflip`). An install not laid out that way fails with a reason.
- The upgrader reads the version it started with. After an OK pull it calls `pulled()` (the restart) only when the package.json on disk is newer than that. Otherwise it logs `update left v<disk>; npm has <latest>` and the hourly check retries, with no restart.

Rejected: a distinct exit code from `update`, and parsing its last line. The disk version is the fact the restart is for.
