# Doctor checks that the hub service's node owns the installed package, and --fix installs the service with that node

Status: accepted (#476)

`kickflip update` installs into the npm prefix that owns the running install (2026-11-07-1300). A hub service whose node comes from another prefix, or from an nvm folder that is gone, ran an old install or failed to start, and doctor said nothing (the 11/06 and 11/09 outages).

- The `hub service node` row reads the node out of the service file (`service.node()`: the plist's first ProgramArguments string, the unit's ExecStart) and compares its prefix, two folders up, with the prefix four folders above the install (`<prefix>/lib/node_modules/@lovek4d/kickflip`). A missing node path or a different prefix is fixable; a clone has no owning node, so only a missing path is flagged. No service file, no row.
- `--fix` runs install, which writes `<prefix>/bin/node` into the service when the install is laid out that way, else the running node as before.

The layout test is install.mjs `installPrefix`; `kickflip update` still carries its own copy of the same check.
