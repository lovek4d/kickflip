# The URL saves the focused card and the selected open-items pill

A board's URL fragment is `#selectedCard=<key>&openItemsCard=<topic id>`. `selectedCard` is the card the owner opened last (the left pane's focus); `openItemsCard` is the selected pill in the right pane on a desktop. A load, a reload or a shared link lands on both.

- The owner's own moves rewrite the fragment in place (`history.replaceState`): Back does not step through them. Owner's answer to `url-state-420-r2-take`.
- An older `#item=<key>[&reply]` link still opens its card, read as `selectedCard`; every link the board writes uses `#selectedCard=`. `#review=<PR>` is read alone as before; the next card or pill change replaces it.
- A pill that is gone is dropped: the pane opens what it would open with none, and the fragment is rewritten to that.
- On a phone the pill is the Waiting on you page, whose URL stays `questions.html#<id>`; `questions.html#openItemsCard=<id>` reads the same.

`AppRouter.fragmentOf` and `hashWith` (router.js) read and write the fragment; `B.saveFragment` (app.js) rewrites it in place.
