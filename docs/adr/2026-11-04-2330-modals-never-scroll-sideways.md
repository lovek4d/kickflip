# Modals never scroll sideways

`.sheet` and `.settings-modal` (with its `.settings-body`) clip `overflow-x` and wrap long text with `overflow-wrap: anywhere`, in style.css. That is the last guard only: a scrolling modal (`overflow-y: auto`) otherwise computes `overflow-x: auto` too.

The element that actually overflowed was `.hub-view code { white-space: nowrap }`, which held a long path in a hub modal at its full width; hub.css now lets code wrap inside `.hub-modal` and `.sheet`.

Checked in headless Chrome at 390px with long unbroken text in a sheet, a form sheet and a settings modal: each dialog's scrollWidth equals its clientWidth.
