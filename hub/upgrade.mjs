// The hub's check for a newer kickflip on npm, and the pull that follows
// (docs/adr/2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md). check() asks the registry for
// @lovek4d/kickflip@latest and, when it is newer than the version in root's package.json (read on each call), pulls it at
// once: run({signal}) → {ok, error} runs `kickflip update --no-restart`, which installs from npm and leaves the hub running. A pull
// that finishes OK calls pulled() only when the package.json on disk is newer than the version the hub started with, and the
// hub answers by restarting itself (self-restart.mjs); an OK pull that left the version put logs both versions instead. A
// failed pull is logged by run and kept for pull(), and the next check tries again. A clone (root has .git) never asks. The hub page's version tap runs check() now (/_hub/check-update) and shows its answer.
// With autoUpdate() false (the hub's auto update box, docs/adr/2026-11-13-2345-a-checkbox-under-the-hubs-version-turns-auto-update-off.md)
// a tick's check still finds the newer version and available() names it, but only a tap's check() pulls it.
// A tick's check only holds the newer version: tick() pulls it once awayFor() (ms the owner has been away, 0 while present) reaches
// AWAY_MS, so an update and its restart never land mid-use; a tap's check() pulls at once
// (docs/adr/2026-11-12-0300-an-npm-hub-pulls-only-once-the-owner-has-been-away-15-minutes.md).
// The hub calls tick() at start and on its 15-second tick; it checks when CHECK_MS of wall-clock time has passed since the
// last check began, a tap's included, so a Mac's sleep can't stretch the wait. Each answer is logged when it changes and
// otherwise at most once an hour, and a pull still running after PULL_MS is aborted through run's signal and logged
// (docs/adr/2026-11-12-0110-the-npm-check-rides-the-hubs-tick-every-15-wall-clock-minutes.md).
import fs from 'node:fs';
import path from 'node:path';

export const LATEST_URL = 'https://registry.npmjs.org/@lovek4d%2Fkickflip/latest';
export const CHECK_MS = 15 * 60_000; // poll: npm-update
export const AWAY_MS = 15 * 60_000;
export const PULL_MS = 10 * 60_000;
const QUIET_LOG_MS = 60 * 60_000;

const parts = (version) => String(version).split('-')[0].split('.').map(Number);
// Whether version a is newer than b, by major, minor and patch.
export function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// → {check(), tick()}; check() → {state: 'clone' | 'same' | 'pulling' | 'failed', latest?, error?}, where pulling means a pull runs (this check
// began it or an earlier one had).
export function upgrader({ root, fetch = globalThis.fetch, run, log = () => {}, pulled = () => {}, now = Date.now, awayFor = () => AWAY_MS, autoUpdate = () => true }) {
  const clone = fs.existsSync(path.join(root, '.git'));
  const installed = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const running = installed();
  let pulling = null;
  let failure = null;
  let checkedAt = null;
  let held = null;
  let newest = null;
  let logged = { line: null, at: 0 };

  function tick() {
    if (checkedAt === null || now() - checkedAt >= CHECK_MS) return check({ hold: true });
    if (held && autoUpdate() && newer(held, installed()) && awayFor() >= AWAY_MS) return pull(held);
  }

  async function check({ hold = false } = {}) {
    if (clone) return { state: 'clone' };
    checkedAt = now();
    let latest;
    try {
      const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`npm answered ${response.status}`);
      latest = (await response.json()).version;
    } catch (e) { log(`kickflip update check failed: ${e.message}`); return { state: 'failed', error: e.message }; }
    const line = `kickflip update check: npm ${latest}, running ${installed()}`;
    if (line !== logged.line || now() - logged.at >= QUIET_LOG_MS) { log(line); logged = { line, at: now() }; }
    if (!newer(latest, installed())) { held = null; newest = null; return { state: 'same', latest }; }
    newest = latest;
    if (hold && (!autoUpdate() || awayFor() < AWAY_MS)) { held = latest; return { state: 'waiting', latest }; }
    pull(latest);
    return { state: 'pulling', latest };
  }

  function pull(latest) {
    if (pulling) return;
    pulling = latest;
    failure = null;
    const limit = new AbortController();
    const timer = setTimeout(() => { log('kickflip update killed after 10 minutes'); limit.abort(); }, PULL_MS).unref();
    run({ signal: limit.signal }).then(({ ok, error }) => {
      if (!ok) { failure = { latest, error }; return; }
      const now = installed();
      if (newer(now, running)) pulled();
      else { log(`kickflip update left v${now}; npm has ${latest}`); failure = { latest, error: `it left v${now} installed` }; }
    }, (e) => { log(`kickflip update failed: ${e.message}`); failure = { latest, error: e.message }; })
      .finally(() => { clearTimeout(timer); pulling = null; });
  }

  // What the hub page reads while it waits out a pull and the restart after it: {state: 'idle' | 'pulling' | 'failed', latest?, error?}.
  // A failure stays until the next pull begins; a pull that installed leaves idle, and the restart under it brings the new version.
  const pullState = () => pulling ? { state: 'pulling', latest: pulling } : failure ? { state: 'failed', ...failure } : { state: 'idle' };

  // The newer version the last check found, or null once the install has it.
  const available = () => (newest && newer(newest, installed()) ? newest : null);

  return { check, tick, available, pull: pullState, clone };
}
