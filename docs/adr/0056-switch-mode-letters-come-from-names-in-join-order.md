# Switch mode's letters come from names, claimed in the order sites joined

On a keyboard, s pressed twice shows **switch mode**: each linked sidebar row's key, and the next key opens that row in place. The first nine boards show 1–9 on their tiles, in sidebar order. Every linked row also answers to a letter from its own name, underlined in its title: the first a–z letter of the title that no earlier claim took. Boards claim first, in the order they joined the hub (the manifest entry's `created`, which `web-ts join` writes for a new route and keeps after), then pages the same way, then the Hub rows in their order. So "s s i" opens iOS however many boards there are, and a new board can move a page's or a Hub row's letter but never another board's. `board/public/ui-sidebar.js` `switchKeys` is the one place the rule lives.

- **Ending it.** Escape, a click, a held modifier, a key in a text field, or 3 seconds with no key ends switch mode with nothing opened; any other key ends it too. s s typed in a text field, a contenteditable or with a dialog open does nothing.
- **Narrow windows.** Below 900px ([0070](0070-phone-headers-sit-at-the-bottom.md)) switch mode opens the drawer with its keys and closes it again when it ends without opening a row; a collapsed rail shows over the page meanwhile and stays collapsed.
- **Other shortcuts.** Switch mode listens on the document in the capture phase and marks each key it uses `defaultPrevented`, which the board's n n skips. A framed page's keys and clicks reach it too (`view-frame.js`).

The owner asked to make the app a robust desktop experience, starting with s s turning each board's icon into a number and a letter that opens a single board (hub/INT-125). From the prototype (`keyboard-switch`) they picked "Letters from names" (`mnemonic`).

Considered:
- assigned keys: numbers for boards and a, b, c… for the other rows in sidebar order (`assigned`). No clashes to settle, but every key follows position, so a new board moves them and the owner reads the sidebar each time;
- letters claimed in sidebar order, which is by route, so a new board whose route sorts first would take an older board's letter;
- only first letters, which leaves every board after the first with that letter without one.
