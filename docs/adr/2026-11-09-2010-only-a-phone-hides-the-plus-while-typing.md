# Only a phone hides the + while typing

The owner, #459, verbatim: "dont dim/hide the plus button on desktop, only hide on mobile".

- style.css no longer dims the floating + or stops its taps while a text field is focused. Under 700px wide it is still `display: none` while `:root.typing` is set ([typing only disables the plus button](2026-11-07-0600-typing-only-disables-the-plus-button.md), amended by #423); wider screens leave it as it is.
- Supersedes the dim and disabled taps on wider screens in the 2026-11-07-0600 ADR.
