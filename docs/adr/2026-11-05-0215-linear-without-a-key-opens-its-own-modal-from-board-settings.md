# Linear without a key opens its own modal from board settings

Status: accepted (#268). Supersedes the "inline, not the modal" sentence of [every new card gets a ticket in the board's current source](2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).

Tapping Linear in Board settings without a working key opens Hub's key modal over the settings modal, as New board does. Closing it returns to settings with the source unchanged; a pasted key that works closes it, picks Linear and turns the status word to `linear · connected`. The inline key field under the Tickets row (`keySlot`, `keyBusy`, `.tk-inline`) is gone; `ticketsControl`'s `keyState` only feeds the status word, and is read again after the modal adds a key.

The stacked modal was the behavior from INT-253 until #126 added the inline field; the owner chose it back (answer gh268-linear, take A of `prototype-linear-modal.html`).
