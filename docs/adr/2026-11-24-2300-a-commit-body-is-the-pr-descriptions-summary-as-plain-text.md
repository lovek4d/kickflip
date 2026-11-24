# A commit body is the PR description's Summary as plain text

A landed commit's body and a PR's description follow one standard, on a board with pull requests and one without.

A builder writes a PR body (`--body-file`) on every board, kept as `agents/<id>.pr-body.md`. A PR merge already used its Summary section as the squash body (the PR body's Summary wrapped at 72); a land with no PR ignored the kept file and wrote the first commit's detail, so the same work read differently by how it landed.

Both paths now render the body in `board/commit-message.mjs` (`detailOf`): the Summary section, markdown stripped to plain prose (heading marks, emphasis, code ticks and fences, link targets and HTML tags gone, their words kept), wrapped at 72. A no-PR land passes the kept body to `squashMessage`; with none kept it falls back to the first commit's detail. The kept file is dropped once a land used it.

The owner chose the Summary only, and plain text, over the whole description or its markdown.
