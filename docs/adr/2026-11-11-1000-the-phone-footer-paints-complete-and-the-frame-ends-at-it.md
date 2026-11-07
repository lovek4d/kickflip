# The phone footer paints complete and the prototype frame ends at it

The viewer's footer height (`--ps-footer-h`) already includes the footer's bottom safe-area padding, so `.kit-served` and `main.proto-main` no longer subtract `env(safe-area-inset-bottom)` again; that second subtraction left a dark band above the footer.

The footer (`.ps-switch`) and the Round pill row (`.ps-top`) start `visibility:hidden` (`.ps-pending`), keep their layout so the footer can be measured at mount, and show together once the first `load()` settles, or after 1.5s if it hangs. The pager, pick row, note field, state chips and Round pill therefore appear in one paint.
