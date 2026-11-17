import fs from 'node:fs';
import path from 'node:path';

// An atomic write names its temp file <file>.<pid>.tmp, or <file>.<pid>.<time>.tmp, and renames it over <file>. A write
// killed between the two leaves the temp file behind, and nothing else removes it.
const TEMP = /\.(\d+)(?:\.\d+)?\.tmp$/;

const running = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Removes each temp file directly in a folder whose writer's pid is not running. → the paths removed.
export function sweepStaleTemps(folder) {
  let names;
  try { names = fs.readdirSync(folder); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const m = TEMP.exec(name);
    if (!m || running(Number(m[1]))) continue;
    const file = path.join(folder, name);
    try { fs.rmSync(file); removed.push(file); } catch {}
  }
  return removed;
}

// Sweeps the kickflip folder and each site's data folder.
export function sweepStaleTempsUnder(home) {
  const sites = path.join(home, 'sites');
  let names = [];
  try { names = fs.readdirSync(sites); } catch {}
  return [home, ...names.map((s) => path.join(sites, s, 'data'))].flatMap(sweepStaleTemps);
}
