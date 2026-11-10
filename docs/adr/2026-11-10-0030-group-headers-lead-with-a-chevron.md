# Group headers lead with a chevron and keep one height

Every group header (a wave or No wave, in every lane) leads with a thin 12px stroke chevron, pointing right when collapsed and down when open, in place of the wave icon. Lane headers keep none. `groupHtml` draws it, so every group gets it from one place; the owner picked take A (thin chevron) from the `wave-chevron` prototype round.

The open header used to carry a `border-bottom: 1px`. A header with wave counts is already taller than its 34px minimum, so the border added 1px when it opened. The divider is now the `.wb-body` border-top, so the header box is the same open or collapsed.
