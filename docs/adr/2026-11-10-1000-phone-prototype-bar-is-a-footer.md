---
status: accepted
---

# On a phone the prototype viewer's bar is a full-width footer

#403. Under 900px the bar (`.ps-switch`) is docked flush to the bottom edge, above the app shell's bar (`--app-bottom`), on every prototype page, with stacked rows as today. The ✕ and Round pill stay floating at the top. The switcher measures the footer and sets `--ps-footer-h`; `main.proto-main`'s bottom padding and `.kit-served`'s height use it, so a served page fills exactly the space above the footer. Desktop (900px+) keeps the floating pill from #419.

The owner picked stacked rows from the prototype `footer-403` (question `gh403-footer-shape`).
