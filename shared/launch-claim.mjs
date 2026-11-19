// docs/adr/2026-11-18-2030-a-launch-is-one-exclusive-claim.md
// The one claim every launch of a run or session takes before it spawns, so two processes that both decide to launch it
// (an old server and its restart, or two passes) launch it once: the claim is a file made with an exclusive create, and
// only the process whose create succeeds spawns.
import fs from 'node:fs';
import path from 'node:path';

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// The claim file is made whole in a temp file and linked into place, so a process that finds it never reads half of it.
function create(file, record) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temp, JSON.stringify(record));
  try { fs.linkSync(temp, file); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { fs.rmSync(temp, { force: true }); }
}

const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// A claim is held while the process it launched lives, or, before its pid is known, while its claimer lives.
const held = (record, alive) => alive(record.pid ?? record.owner);

// Claims name in dir, creating it. → {settle(pid), release()} when this process won the claim, null when another holds
// it. A claim whose process is gone is stale: it is moved aside by a rename, which only one process wins, and claimed
// again through the same exclusive create. alive(pid) is whether a process lives.
export function claimLaunch(dir, name, { alive = pidAlive } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, encodeURIComponent(name));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (create(file, { owner: process.pid })) {
      return {
        settle: (pid) => { const temp = `${file}.${process.pid}`; fs.writeFileSync(temp, JSON.stringify({ owner: process.pid, pid })); fs.renameSync(temp, file); },
        release: () => release(dir, name),
      };
    }
    const record = read(file);
    if (record && held(record, alive)) return null;
    const aside = `${file}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try { fs.renameSync(file, aside); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    // A claim made in the moment since it was read is another process's: it goes back.
    const moved = read(aside);
    fs.rmSync(aside, { force: true });
    if (moved && moved.owner !== record?.owner) { create(file, moved); return null; }
  }
  return null;
}

// Whether a claim on name is held: its launch is under way, or the process it launched lives.
export function claimed(dir, name, { alive = pidAlive } = {}) {
  const record = read(path.join(dir, encodeURIComponent(name)));
  return Boolean(record) && held(record, alive);
}

// Frees the claim on name: the run it launched ended, or was stopped.
export function release(dir, name) {
  fs.rmSync(path.join(dir, encodeURIComponent(name)), { force: true });
}
