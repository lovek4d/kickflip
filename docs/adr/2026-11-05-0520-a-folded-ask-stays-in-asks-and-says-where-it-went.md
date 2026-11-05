# A folded ask stays in Asks and says where it went

An ask folded into a card (`item relate-ask`) used to lose its own card: it showed only in the card's thread, marked Moved, and vanished from where the owner looks.

It now stays listed in Asks, with a thread line "Moved to <ref>: <title>" linking to the card. The card's thread keeps its Moved line, and `ask unfold` still works. An ask that became work (`from_ask`) is unchanged: it has no card of its own.
