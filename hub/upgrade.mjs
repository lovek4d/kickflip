// The hub's check for a newer kickflip on npm, and the update the sidebar's Upgrade asks for
// (docs/adr/2026-11-03-1521-the-hub-offers-a-newer-kickflip-from-npm.md). check() asks the registry for
// @lovek4d/kickflip@latest; state() compares it with the version in root's package.json, read on each call so a finished
// install offers nothing. A clone (root has .git) never asks and never offers. request() asks for the update: it runs
// once builders() lists no running builder, and tick() tries again while it waits. run() → {ok, error} runs
// `kickflip update`, which installs from npm and restarts the hub; the app's reload row follows once the new code runs.
// changed() is called whenever state() may answer differently.
import fs from 'node:fs';
import path from 'node:path';

export const LATEST_URL = 'https://registry.npmjs.org/@lovek4d%2Fkickflip/latest';
export const CHECK_MS = 60 * 60_000;

const parts = (version) => String(version).split('-')[0].split('.').map(Number);
// Whether version a is newer than b, by major, minor and patch.
export function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// → {check(), state(), request(), tick()}; state() → null | {state: available | waiting | updating | failed, version,
// builders (waiting), error (failed)}
export function upgrader({ root, fetch = globalThis.fetch, builders, run, log = () => {}, changed = () => {} }) {
  const clone = fs.existsSync(path.join(root, '.git'));
  let latest = null;
  let asked = false;
  let running = false;
  let waitingFor = 0;
  let error = null;

  const installed = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

  async function check() {
    if (clone) return;
    try {
      const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`npm answered ${response.status}`);
      latest = (await response.json()).version;
    } catch (e) { log(`kickflip update check failed: ${e.message}`); }
    changed();
  }

  function state() {
    if (clone || !latest || !newer(latest, installed())) return null;
    if (running) return { state: 'updating', version: latest };
    if (asked) return { state: 'waiting', version: latest, builders: waitingFor };
    if (error) return { state: 'failed', version: latest, error };
    return { state: 'available', version: latest };
  }

  // One tick at a time, so a tap and the timer never both start the update.
  let ticking = Promise.resolve();
  const tick = () => (ticking = ticking.catch(() => {}).then(tickOnce));
  async function tickOnce() {
    if (!asked || running) return;
    waitingFor = (await builders()).length;
    if (waitingFor) { changed(); return; }
    asked = false;
    running = true;
    error = null;
    changed();
    run().then(({ ok, error: why }) => { if (!ok) error = why; }, (e) => { error = e.message; })
      .finally(() => { running = false; changed(); });
  }

  async function request() {
    if (!state()) throw Object.assign(new Error('kickflip is up to date.'), { status: 409 });
    if (!running) asked = true;
    await tick();
    return state();
  }

  return { check, state, request, tick };
}
