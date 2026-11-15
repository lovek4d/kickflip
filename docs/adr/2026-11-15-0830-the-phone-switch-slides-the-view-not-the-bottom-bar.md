# The phone switch slides the view, not the bottom bar

#752. The owner, verbatim: "Page footer blinks in and out switching between board and open questions". Amends [On a phone the board and Waiting on you switch in place](2026-11-14-2332-on-a-phone-the-board-and-waiting-on-you-switch-in-place.md), whose 180 ms slide animated the shown view's root.

Below 900px the bar under the page (`header.top`, fixed to the bottom) and the + are fixed children of the view's root. A `transform` or `opacity` animation on that root makes it their containing block and fades them, so on every switch they slid 24px and faded from 0.6 as the other view's bar was swapped in: a blink.

The slide now animates the root's `main` and `.split`, the page's content, in `shell.js slide`. The bar and the + are not in what animates, so each view's bar appears at once, in place. The two views still paint their own bar (the board's has the refresh and the ?, Waiting on you's the check); one shared bar would need the two headers merged and is not done here.
