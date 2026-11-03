# Kickflip ships as a minified npm package

Kickflip installs from public npm as `@lovek4d/kickflip` on Node 22+. The source repo stays private. esbuild minifies JavaScript per file, preserving the source layout so relative imports, path-based spawns and paths named by the skill and hooks plugin keep working. SKILL.md, CONTEXT.md, docs/hub-session.md, board and starter public files, hub/sw.js, the hooks plugin, LICENSE and README ship readable.

The package root comes from the running binary's own location, which Node resolves through symlinks. `kickflip install` links `~/.claude/skills/kickflip` to that root. The owner keeps a clone and uses `npm install`, `npm link`, then `kickflip install`, so the same link points to the clone. `kickflip update` runs `npm i -g @lovek4d/kickflip@latest`, then restarts the hub through the host's service manager. It refuses a Git checkout, which updates with `git pull`, to preserve the owner's npm link.

Board repo clones and their session folders live in `~/.claude/kickflip/repos/<owner>/<repo>` outside a clone, since npm replaces the installed package folder on update. A clone keeps `<clone>/.repos/<owner>/<repo>`.

`npm run build` makes the complete package in `dist/`, taking the shipped file list from npm's `files` allowlist. Tests, test-only helpers and docs/adr stay out. Publishing uses `dist/` with its own package.json, without development dependencies or build scripts. The root package.json is private so the clone's unminified source cannot be published by mistake.

The Prosperity license still governs the package. Minification makes distribution smaller and keeps readable source in the private repo; a determined user can still read minified JavaScript.

Considered: a compiled single binary per platform with Node SEA or `bun build --compile`, installed by a Homebrew tap or curl script. It needs a build per platform and a download host, while plain files still have to live beside it. Bundling one file per entry point breaks path-based spawns and the hub's own code hash: `hubCode` in hub/boards.mjs follows relative imports.

The command `kickflip install` was later renamed `kickflip init`, with no `install` alias; the text above keeps the old name.

A `v*` tag later made GitHub Actions the publisher, gated on the suite, the build and a smoke install ([0158](0158-a-v-tag-publishes-kickflip-to-npm.md)).
