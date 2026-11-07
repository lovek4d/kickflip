// The hub's check for a newer kickflip on npm, and the pull that follows
// (docs/adr/2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md). check() asks the registry for
// @lovek4d/kickflip@latest and, when it is newer than the version in root's package.json (read on each call), pulls it at
// once: run() → {ok, error} runs `kickflip update --no-restart`, which installs from npm and leaves the hub running. A pull
// that finishes OK calls pulled() only when the package.json on disk is newer than the version the hub started with, and the
// hub answers by restarting itself (self-restart.mjs); an OK pull that left the version put logs both versions instead. A
// failed pull is only logged by run, and the next check tries again. A clone (root has .git) never asks.
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

// → {check()}
export function upgrader({ root, fetch = globalThis.fetch, run, log = () => {}, pulled = () => {} }) {
  const clone = fs.existsSync(path.join(root, '.git'));
  const installed = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const running = installed();
  let pulling = false;


  async function check() {
    if (clone) return;
    let latest;
    try {
      const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`npm answered ${response.status}`);
      latest = (await response.json()).version;
    } catch (e) { log(`kickflip update check failed: ${e.message}`); return; }
    if (newer(latest, installed())) pull(latest);
  }

  function pull(latest) {
    if (pulling) return;
    pulling = true;
    run().then(({ ok }) => {
      if (!ok) return;
      const now = installed();
      if (newer(now, running)) pulled();
      else log(`update left v${now}; npm has ${latest}`);
    }, (e) => log(`kickflip update failed: ${e.message}`))
      .finally(() => { pulling = false; });
  }

  return { check };
}
