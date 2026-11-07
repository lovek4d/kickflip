# The board page's phone bottom bar hides while a text field has focus

Extends 2026-11-07-0600-typing-only-disables-the-plus-button.md (#360, #423).

The owner (#433), verbatim: "Can we also disable the footer on mobile when a text field is focused, same as the plus button?"

- "The footer" is the board page's bottom bar on a phone (board name, time, refresh, ? count), shown from the owner's screenshot. The prototype viewer's footer is unchanged.
- Under 700px wide, `:root.typing` hides that bar (`display: none`) as it hides the +. `--app-bottom` is untouched, so the page does not move.

Not checked on a phone.
