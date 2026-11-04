# Every text box the owner sends from attaches through attach.js, and an edit can add files

#137: the owner asked to "drag and drop images into any of the text boxes that also accept attachments", and for every text box to take attachments the same way. The new task, a thread reply and a question's note each had a file button through `board/public/attach.js`; none took a drop or a paste, and a message's edit box took no files at all. The owner picked take A of the drop-attach prototype.

- **One helper.** A composer is any `[data-composer="<id>"]` holding `BoardUI.attachButton()`, a `[data-files]` list and its text box inside `BoardUI.dropZone()`. attach.js listens on the document, so a picked, dropped or pasted file uploads the same way, to the site's `api/upload` (data/uploads), with the same chips. A new composer gets all three by using those three pieces; it writes no listener of its own.
- **Dragging looks like take A.** A drag carrying files over a composer marks it `.dragging`, counting `dragenter`/`dragleave` on its children; the drop zone gets a dashed `--accent` outline with "Drop to attach" over the box. A drop ends it. A drag of text is left alone. Files dropped outside every composer are taken and dropped, so a near miss never has the browser open the file over the board.
- **Paste.** A paste carrying files into a composer attaches them in place of pasting; a paste of text alone pastes as usual.
- **Chips.** An image gets its thumbnail, any other file a chip with its name on one line, cut with an ellipsis, its full name as the chip's title.
- **An edit adds files.** The edit box is composer `edit:<event id>`. Save waits while its files upload and sends them as `ask-edited {id, key?, text, files}`. `domain.mjs` `threadOf` appends each edit's files, oldest edit first, after the files the message was sent with, and an ask's card takes the same list; `ask move` copies them too. An edit never removes a file. Cancel, delete, or a saved edit clears the box's files; a failed save keeps them with the reopened box.

Not composers: the rules editor's boxes (one-line rules Claude reads as text) and Settings' single-line fields (a name, a confirm word, a Linear key, the new board form).

Considered:
- each composer wiring its own drag and paste handlers: the same logic in every view, which is what the owner asked to avoid;
- the helper wrapping the text box at drag time: moving a focused textarea drops its focus and, on iOS, the keyboard, and setHTML's patching would undo it on the next paint;
- an edit that replaces the message's files: a file can't be taken back from Claude once it has been read, and the box would need the old files as removable chips.
