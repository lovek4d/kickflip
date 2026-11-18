# A script Run runs exactly the approved bytes

The owner approves a script by its sha256, which the Run tap names. Before this, the server checked the tap's sha
against the offer's stored sha, but the runner then re-read the offer from the thread, so text changed in the thread
file between the check and the read would have run unapproved.

At Run the server recomputes the sha256 of the stored body and refuses (409) unless it equals the stored sha as well as
the tap's sha. It then starts `board/bin/script-run.mjs` with that body on stdin; the runner reads no thread or file, so
there is nothing to swap between the check and the run.

Stdin was chosen over a 0600 `run-<id>` snapshot file: a file is something to swap. Kickflip-held build scripts
(docs/adr/2026-11-17-2330-board-settings-edits-a-boards-kickflip-held-scripts.md) are a different path and are not
changed here.
