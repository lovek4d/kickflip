# Board settings and Repo review open as centred modals; the pane holds only board items

Status: accepted (#1209, 11/25). Amends [one standard sheet size](2026-11-18-0415-one-standard-sheet-size.md) and the one-root rule of [a sheet stacks only from a tap inside another](2026-11-24-0300-a-sheet-stacks-only-from-a-tap-inside-another.md).

The owner: "board settings should go back to a central modal, pane is only for board items". Asked about the rest, they chose Repo review as a centred modal too, and a card open in the pane staying open beneath.

- **From 900px**, board settings (`.settings-modal`) and Repo review (`.arch-sheet`) are centred modals with a backdrop, 680px wide at most (style.css). The hub's own modals were already this; the hub-only rule in hub.css folded into the one rule.
- **The pane holds the reader family only** (`.sheet.reader-sheet`): `--sheet-w`, the slide in, the peek strips.
- **A centred modal opens over the pane, not in place of it.** `openSheet(sheet, { centred: true })` (ui.js) skips the one-root replacement from 900px, so the card open in the pane stays open beneath. The sheets beneath get no peek strip (`restack` counts strips without it). Escape closes the modal and leaves the card.
- **Phones are unchanged**: the full-height standard sheet, replacing the stack like every sheet.
