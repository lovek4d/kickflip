# Migrations run once per ledger, from one list

Status: accepted

The hub ran its migrations once, each copying the same ledger code: take the manifest lock, read `migrated`, skip a
listed id, run, append the id and write. The board server ran every one of its migrations at every start, each in its
own try line, and relied on each leaving data already in shape as it was. Nothing said when a board migration had
reached every board, so none could ever be deleted (T-596 architecture review; the owner took this fix).

- `board/migrations.mjs` holds `MIGRATIONS`, every data migration as `{id, scope: 'hub'|'board', run}` in the order
  it runs. Adding a migration is one entry there.
- `runMigrations(scope, ctx)` runs each migration of the scope its ledger doesn't list, each under that ledger's lock,
  and adds its id once it returns. The hub calls `runMigrations('hub')` as it starts, before any board; the board
  server calls `runMigrations('board', {site, archived})` as it starts, where its try lines were.
- Two ledgers. The hub's is the manifest's `migrated` list, as before, so its ids (`board-github`, `hub-local`,
  `wave-names`, `drop-waves`) keep their records. A board's is `data/migrated.json`, `{migrated: [ids]}`, locked by
  `hub/locks.mjs` `withFileLock` while one migration runs. A hub run gets the locked manifest and changes it; the
  runner writes it. A board run writes the board's files itself, through `files.mjs`.
- A migration that throws is logged as `<id> migration failed: …` and left off its ledger, so it runs again at the next
  start; the ones after it still run, as the try lines did. A hub with no boards in its manifest runs none and records
  none, so the first board it gets is migrated, as before.
- `kickflip migrations` (`migrationsLeft`) prints each migration with the ledgers that don't list it yet, closed boards
  included, since a reopened board's server runs what its ledger lacks. Once it reads "every ledger lists it", the
  entry and its code can go.

The first start after this lands runs every board migration once on each board, as every start did before, and
records them; later starts skip them.

The hub's other start-up checks (`migrateCellarNode`, `migrateTriage`, `migrateSettings`) and the store's
`fallBackFromLinear` stay outside the list: each checks its own data at every start and keeps no ledger.
`splitSharedNotes` is listed but stays in store.mjs with the notes code it shares.
