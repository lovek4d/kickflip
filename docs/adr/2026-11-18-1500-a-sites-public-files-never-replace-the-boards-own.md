# A site's public/ files never replace the board's own

A file an agent wrote in a site's public/ named like a board script (app.js, claude.js) was served to the board app in its place, running with the owner's rights on the board origin; the sandbox header covers only the previews, not a script the app loads.

The board's own static roots (template public/, starter/public, shared/) are now looked up first and the site's public/ last. The site keeps every path the board doesn't use. Starter comes before the site because the app loads starter's claude.js; no site relied on shadowing.
