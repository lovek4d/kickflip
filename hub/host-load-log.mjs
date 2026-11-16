// docs/adr/2026-11-17-0010-the-load-sheet-accent-follows-busy-and-each-tick-logs-its-rows.md
// ~/.claude/kickflip/logs/host-load.jsonl: one JSON line for each hub tick that read the load, to audit later what was
// loading the host: {ts, load, cores, busy, groups: [{name, count, cpu}], rows: [{pid, ppid, command, cpu, age, group}]}.
// The first write of a new local day moves the file to host-load-<its day>.jsonl, and the days past KEEP_DAYS are deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEEP_DAYS = 14;
const ROTATED = /^host-load-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// data: machineLoad's {load, cores, busy, groups}; a null groups (ps gave no answer) writes empty ones.
export function logHostLoad(data, { dir = path.join(os.homedir(), '.claude', 'kickflip', 'logs'), now = new Date() } = {}) {
  const file = path.join(dir, 'host-load.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const day = localDay(new Date(JSON.parse(first).ts));
    if (day !== localDay(now)) fs.renameSync(file, path.join(dir, `host-load-${day}.jsonl`));
  }
  const groups = data.groups ?? [];
  const line = {
    ts: now.toISOString(), load: data.load, cores: data.cores, busy: data.busy,
    groups: groups.map((g) => ({ name: g.key, count: g.rows.length, cpu: Math.round(g.rows.reduce((n, r) => n + r.cpu, 0) * 10) / 10 })),
    rows: groups.flatMap((g) => g.rows.map((r) => ({ pid: r.pid, ppid: r.ppid, command: r.command, cpu: r.cpu, age: r.age, group: g.key }))),
  };
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  const cutoff = localDay(new Date(now.getTime() - KEEP_DAYS * 86400_000));
  for (const name of fs.readdirSync(dir)) {
    const day = name.match(ROTATED)?.[1];
    if (day && day < cutoff) fs.rmSync(path.join(dir, name));
  }
}
