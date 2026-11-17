# The hub sweeps dead writers' temp files at boot

An atomic write names its temp file `<file>.<pid>.tmp` (some add a time) and renames it over the file. A write killed between the two left the temp file behind, and ~/.claude/kickflip had collected a dozen `usage.json.<pid>.tmp`.

At boot the hub removes temp files in ~/.claude/kickflip and each site's data folder whose pid is not running (hub/stale-tmp.mjs). Temp files named by a random id, not a pid, are left alone, as is a file whose pid a live process now holds.
