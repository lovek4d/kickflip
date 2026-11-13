# Render and layout tests share one Chrome per file

`sharedChrome()` in shared/test-helpers.mjs starts one headless Chrome in `before()` and stops it in `after()`; its `probe(url, width)` opens a tab, sets the width, loads the page and reads the JSON the page writes into `<pre id="probe">` (#626, from #254). shared/chrome.mjs holds the Chrome launch (with its one retry in a fresh profile) and the tab driver, which board/render-check.mjs uses too. board/send-bar-snug, no-sideways-scroll, main-pull-centre, thread-box-height and prototype-phone tests use `probe`; board/render-check.test.mjs starts its Chrome the same way and hands the `board.mjs` runs its port in `KICKFLIP_RENDER_CHROME_PORT`, so each check opens a tab in it and leaves the Chrome running. With that variable unset, the check launches a Chrome of its own, as a board does; the two Chrome-fails-to-start tests leave it unset.

**Why.** Each check and each probe launched a fresh Chrome: render-check.test.mjs alone summed 198 s over 7 tests.

**Supersedes** [page-probes-are-written-as-the-page-parses](2026-11-12-0100-page-probes-are-written-as-the-page-parses.md) in its `--dump-dom` mechanism: `dumpProbe` and its second run are gone; `probe` waits until the page has written `#probe`, with the board's usual wait budget. The probe is still written as the page parses, with no timer. prototype-phone's `phoneProbe` keeps its 800 ms timer, since its probe posts from an iframe of the served page.

**Viewport.** A tab sets its width with `Emulation.setDeviceMetricsOverride`, so a width under 500 px is real, where `--window-size` was not.
