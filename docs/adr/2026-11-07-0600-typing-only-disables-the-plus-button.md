# Typing only disables the + button; the page stays still

Reverses 2026-11-05-1834-while-typing-the-header-is-a-strip-and-the-send-bar-sits-on-the-keyboard.md (#325) and the keyboard dock of 2026-11-05-2150-questions-bar-docks-on-the-keyboard.md (#303).

The owner (#360), verbatim: "Thread and open questions are still a bit tough to float above the keyboard, the header does not hide. Maybe instead let's just try to disable the plus button when focused and leave everything else on the page statically"

- shell.js sets `:root.typing` while a text field has focus and clears it on focus out. style.css dims the floating + and stops it taking taps under that class. Nothing else changes.
- Removed from #325: the visualViewport dock (`kb-up`, `--keyboard`, `--keyboard-top`, `.docked`), the 26px header strip with "· typing", and the docked Questions bar and thread row.
- Kept: nothing of #325 was independent of docking. The sheets' own keyboard fit (`--kb`, dialogs.js fitSheet) is separate and untouched.

Amended by #423, the owner verbatim: "+ should fully hide when text fields are focused, not just dim. and only on mobile". Under 700px wide (the phone layout) `:root.typing .fab` is `display: none`; wider screens kept the dim and the disabled taps until #459 ([only a phone hides the + while typing](2026-11-09-2010-only-a-phone-hides-the-plus-while-typing.md)).

Not checked on a phone.
