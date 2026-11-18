# Composer drafts live on the server

A thread reply's draft and the New task box's draft live on the server of the page they're on, one copy for every
device: a board's in its `data/drafts.json`, the hub page's New task draft in the hub's own `data/drafts.json`. They used
to live in each browser's local storage (`draft:<card key>`, `site:<route>:draft:ask`), so a reply begun on the phone
wasn't on the Mac, and clearing site data lost it (owner, T-532, T-535).

- `board/drafts.mjs` keeps `{drafts: {id: {text, files, at}}}`, keyed by the box's composer id: `item:<card key>` for a
  thread reply, `ask` for New task. `at` is the server's time of the draft's last save, each later than the one it
  replaced. Sending empties a draft but keeps it, empty, with its time, so a board answer from before the send can't
  bring the text back on another device.
- `POST <board>/api/drafts {id, text, files}` and `POST /_hub/api/drafts` (ask only) save one, waking no session. Every
  board answer carries all of the board's drafts as `drafts`, and `/_hub/api/hub` the hub's, so a save reaches the other
  devices with the change signal it sends.
- A draft is saved after a 1 s pause in typing, as its box loses focus, and as the page hides (owner, t535-when), and
  as its files change once none is uploading (`board/public/drafts.js`). A save of what the server already has sends
  nothing.
- Files go with the draft (owner, t535-files): each uploaded file, its url only `uploads/<ms>-<name>` from the site's
  own upload, its path rebuilt by the server from its data dir.
- Last save wins (owner, t535-two-devices): a draft newer than the page has fills its box and files, but never a box
  with focus, a pause still running or a save that failed. That box keeps what is typed and saves it over the newer one.
- A reply's draft goes when its card leaves the board (owner, t535-lifetime), on the server's pass after each board
  change, as read marks do ([read marks live on the board](2026-11-05-0910-read-marks-live-on-the-board.md)).
- A browser's old local drafts move to the server once, on the first board answer that carries drafts, each only where
  the server has none for its box, and their local keys are deleted.
- A question's unsent pick and note, which the questions sheet and the prototype viewer's Choose this share, are the draft
  `q:<question id>` in the same store (T-690, owner t535-boxes): `text` is the note, `choice` the pick, absent until
  one is made and null once cleared, and no files. They save as the other drafts do (`BoardUI.questionDrafts` in
  `board/public/ui-questions.js`), after a 1 s pause, as a box loses focus and as the page hides, and the viewer's
  Choose this saves at once as the page leaves. A newer draft from another device replaces the page's copy and redraws its
  question's card, except a note being typed in or changes not yet saved, which save over it. They come back inside
  their question only, with no mark elsewhere (owner, t535-pick-mark). Sending answers or a request empties the draft; the
  server's pass after each board change drops one whose question has left the board's open questions (owner,
  t535-lifetime). A browser's old `qdraft:<id>` keys move once, each where the server has no draft for its question,
  and are deleted. The ask Edit form keeps none; it is being removed (T-693).
