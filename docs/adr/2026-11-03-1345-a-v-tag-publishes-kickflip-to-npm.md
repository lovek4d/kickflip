# A v* tag publishes kickflip to npm

Pushing a `v*` tag to lovek4d/kickflip runs `.github/workflows/release.yml`, which publishes `dist/` as `@lovek4d/kickflip` ([kickflip ships as a minified npm package](2026-11-01-2247-kickflip-ships-as-a-minified-npm-package.md)). Nothing else publishes; there is no GitHub release, since the tag and npm are enough.

**The session bumps the version.** When the owner asks for a release, the session runs `npm version <x.y.z>` in the clone, which commits the bump and makes the `v<x.y.z>` tag, then pushes main and the tag (`git push origin main v<x.y.z>`).

**The workflow gates publishing.** On ubuntu-latest with Node 22 it runs, in order: the full suite (`node --test`), `npm run build`, a check that the tag is `v` plus `dist/package.json`'s version, failing otherwise, and a smoke install: `npm pack ./dist`, a global install of that tarball into a temporary prefix, and a bare `kickflip`, which must print its usage text. Then `npm publish ./dist --access public`.

**npm auth is trusted publishing.** The job has `id-token: write`; npm exchanges the GitHub OIDC token for a short-lived publish credential, so no npm token is stored. Trusted publishing needs npm 11.5.1 or later, so the job installs npm 11 over Node 22's npm 10. npm's package settings name the trusted publisher: repository lovek4d/kickflip, workflow `release.yml`. The publish has no `--provenance`: npm makes provenance only for public source repositories and refuses it from a private one.

Considered:
- releasing on a version bump pushed to main, or a manual dispatch: a tag names the release in one step the session already takes with `npm version`;
- a granular automation token as a repo secret: the owner's account uses passkey 2FA, so the token would need the bypass-2FA setting, and it is a secret to rotate.
