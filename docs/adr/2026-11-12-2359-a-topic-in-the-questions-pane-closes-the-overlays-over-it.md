# A topic in the questions pane closes the overlays over it

Status: accepted

From 900px, picking a topic in the pane (a pill tap, or a questions URL through `focusQuestion`) shows that topic's
questions. Anything laid over the pane would hide them, so one step closes it: `showTopic` in
`board/public/app-pane.js`, run on the pane's `onTopic`. It walks `paneOverlays`, a single list of what can cover the
pane: the reader sheet (notes, logs, transcripts; `B.closeReader`) and the prototype viewer. The prototype viewer's
close moved there from `focusQuestion`, which now reaches it through `onTopic` like a pill tap does.

A new overlay over the pane, such as the thread's questions modal, joins `paneOverlays` rather than adding a second hook.
