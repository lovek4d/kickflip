# Waiting and paused read gray; thinking shows only while the orchestrator is on it

A card waiting on the orchestrator reads "waiting for orchestrator" in gray until its watcher wakes and it picks the card up, then "orchestrator review" or "thinking" in the lane's colour. While Claude's usage is paused, the same lines read "paused" in gray instead.

Every paused status takes the one class `.paused` (board/public/style.css), gray: the card and thread line, the header's "paused until", the sidebar's board and hub rows (tone `paused`), and the hub's pause banner. The board view hands the hub's pause to `BoardUI.usagePause`, which the card and thread lines read.
