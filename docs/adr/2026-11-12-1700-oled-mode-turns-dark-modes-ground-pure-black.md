# OLED mode turns dark mode's ground pure black

Hub settings gets an Appearance row that opens a sheet with an "OLED mode" toggle ("Applies in dark mode. Saved on this device."). On, dark mode's ground is take C of the dark-palette prototype round (the owner picked it on oled-mode: "Pure black as shown"): --bg #000000, --panel #08080a, --line #1c1c20, --text #f2f2f5, --muted #85858f, --accent-soft #0d141d, --chip #121215, --band #0d0d0f, --claude #17120a.

- **Per device.** The choice is the localStorage key `hub:oled` (`1` is on), like `hub:sidebarCollapsed`; a head script in app.html, log.html, progress-review.html and prototype.html sets `data-oled` on :root before the stylesheets, so there is no flash. The hub's settings.json is untouched and no server injects anything.
- **Dark only.** colors.css holds the override as `:root[data-oled]` inside its dark block, so light mode never changes. The toggle shows in both modes.
- **Ground only.** The semantic colours (--accent, --ok, --warn, --bad, --purple) are unchanged, so red > orange > blue > green > grey reads as on [take A's palette](2026-11-12-0020-dark-mode-uses-a-near-black-linear-style-palette.md).
- Pages framed in the shell from other sites keep their own palettes.
