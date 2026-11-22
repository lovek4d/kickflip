# A visuals or prototype link must name a page the board serves

A `thread --link` and a question's `url` were checked only for shape (`checks.mjs` `pageUrl`), so a link to a page saved outside the site's `public/visuals` posted fine and 404'd when tapped (T-796).

- `questions.mjs` `pageServed` refuses a `visuals/<id>/<page>.html` link whose file is not in the site's `public` folder, and a `prototype-<topic>.html` link that is neither a recorded prototype's page nor a hand-written file there. The refusal names the path it looked for.
- A question's prototype url keeps its own, stricter recorded-prototype check; `pageServed` covers its visuals url.
- An http(s) link is not the board's to check.
