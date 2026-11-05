// The hub's check for a newer kickflip on npm, and the pull that follows
// (docs/adr/2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md). check() asks the registry for
// @lovek4d/kickflip@latest and, when it is newer than the version in root's package.json (read on each call), pulls it at
// once: run() → {ok, error} runs `kickflip update --no-restart`, which installs from npm and leaves the hub running. state()
// then reads "updated" while the installed version is newer than `running`, the version this hub started with, until the
// hub restarts. A clone (root has .git) never asks and never offers. request() pulls again after a failure.
// changed() is called whenever state() may answer differently; pulled() when a pull finished OK, which the hub answers by
// restarting itself (self-restart.mjs); "updated" and its Restart remain for a restart that failed.
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

// → {check(), state(), request()}; state() → null | {state: updating | updated | failed | available, version, error (failed)}
export function upgrader({ root, running: runningVersion, fetch = globalThis.fetch, run, log = () => {}, changed = () => {}, pulled = () => {} }) {
  const clone = fs.existsSync(path.join(root, '.git'));
  let latest = null;
  let pulling = false;
  let error = null;

  const installed = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

  async function check() {
    if (clone) return;
    try {
      const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`npm answered ${response.status}`);
      latest = (await response.json()).version;
    } catch (e) { log(`kickflip update check failed: ${e.message}`); }
    if (latest && newer(latest, installed())) pull();
    changed();
  }

  function state() {
    if (clone) return null;
    const on = installed();
    if (newer(on, runningVersion)) return { state: 'updated', version: on };
    if (!latest || !newer(latest, on)) return null;
    if (pulling) return { state: 'updating', version: latest };
    if (error) return { state: 'failed', version: latest, error };
    return { state: 'available', version: latest };
  }

  function pull() {
    if (pulling) return;
    pulling = true;
    error = null;
    run().then(({ ok, error: why }) => { if (ok) pulled(); else error = why; },(e) => { error = e.message; })
      .finally(() => { pulling = false; changed(); });
  }

  async function request() {
    if (!state() || state().state === 'updated') throw Object.assign(new Error('kickflip is up to date.'), { status: 409 });
    pull();
    changed();
    return state();
  }

  return { check, state, request };
}
