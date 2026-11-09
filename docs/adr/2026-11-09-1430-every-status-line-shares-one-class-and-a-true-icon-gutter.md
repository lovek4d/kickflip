# Every status line shares one class and a true icon gutter

Every thread status line (request, board line, move, status, agent, visual and ask-link, judgment calls, folded run) takes the one `status-line` class. Its rule alone holds padding, a 4px margin, 12px text and wrapping; each kind's rule keeps only its colour and weight.

The mark sits in a 23px gutter: a line hangs its text with a negative text indent, so wrapped text lines up under the first line's text, never under the mark. A fold's summary hangs the same way inside its box.

Board lines had double gaps and lost the space before "·" because the header logo's `.hub { display: inline-flex }` also matched `.msg.request.hub`; the rule is now `a.hub`. Ask-link and visual lines drop from 13px to the 12px every other line uses.
