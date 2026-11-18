# CI tests every push to main and every pull request, with SHA-pinned Actions

`test.yml` ran only on demand. It now also runs on push to main and on pull requests, so a change is proven on CI's runner before a release candidate exists. Every `uses:` in both workflows names a full commit SHA with its release in a comment, because a tag can be moved to different code. `shared/workflows.test.mjs` fails on a tag-pinned Action.

`SECURITY.md` carries the threat model and sends reporters to GitHub private vulnerability reporting, which the owner turns on in the repository settings.
