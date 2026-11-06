# The prototype page fits a phone

Takes lay fixed-width frames (390px phone, 720px desktop) in flex-wrap rows, and the viewer's note field was 14px, so on a phone panels were cut off by the stage's clip and focusing the note zoomed iOS Safari.

The shared frame, `board/public/prototype.html`, now caps every box in the stage to the stage's width under 600px, so a wrapping row of frames stacks in one column. Every input, select and textarea in the stage is 16px, and so is the viewer's note field (`prototype-switcher.js`). Takes written later inherit both; the rule for takes (side-by-side panels wrap) is in the header of `prototype-kit.js`.

Considered: forcing every grid to one column. It can't tell a take's panel pair from a card's own two-button row, so only the width cap is generic.
