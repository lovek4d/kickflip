# Removing a tag or link pill asks to confirm

An open card's Tags × and Related to × each ask the board's confirm dialog (the one Serve and Kill use) before sending
card-tag or card-relate, and send nothing on No: "Remove the tag <tag> from <ref>?" and "Unlink <ref> and <other ref>?
Both cards drop the link."

Why: the × sits against the pill and one stray tap dropped a tag or a two-sided link with no undo. Adding stays
unconfirmed: the tag picker's toggles and the link search's × (which only closes the search) are cheap to reverse.
