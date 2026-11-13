// docs/adr/2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md
// What is loading this Mac, for the sheet the Hub row's busy word opens (ui-sidebar.js loadSheet): the load now and over
// the last hour (the samples the hub's tick keeps, shared/machine-gate.mjs), and this Mac's processes from one ps call,
// sorted into groups. All of it is mechanical; no model reads any of it.
// - builder: a board's open builder or planner record's process (board/store.mjs openBoardBuilders).
// - session: a running Claude Code session's process (~/.claude/sessions, live.mjs), named by the board it owns.
// - orphan: a node process of this user's, older than a day and left to launchd (parent pid 1), that isn't the hub.
// - suite: a `node --test` run inside no orphan and no other suite, owned by the builder or session above it.
// - other: what no group holds, at OTHER_CPU% or more, the busiest OTHER_ROWS.
// A row's CPU is its own and its children's that aren't rows themselves. Stop ends an orphan alone.
import os from 'node:os';
import path from 'node:path';
import { ps as runPs, sessionRecords } from './live.mjs';
import { listBoards } from './boards.mjs';
import { openBoardBuilders } from '../board/store.mjs';
import { readMachine, readMachineSamples } from '../shared/machine-gate.mjs';
import { audit as writeAudit, hubAudit } from '../shared/audit.mjs';

export const ORPHAN_AGE = 86400;
const OTHER_CPU = 10;
const OTHER_ROWS = 5;
const COMMAND_LENGTH = 80;
const PS_COLUMNS = ['-axo', 'pid=,ppid=,uid=,etime=,pcpu=,command='];
export const GROUPS = [['orphan', 'Looks orphaned, older than a day'], ['suite', 'Test suites'], ['session', 'Claude sessions'], ['builder', 'Builders and planners'], ['other', 'Other']];
const NO_OWNER = 'no board or session';

// ps's elapsed time, [[dd-]hh:]mm:ss → seconds.
export function etimeSeconds(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : [0, text];
  return Number(days) * 86400 + clock.split(':').reduce((n, part) => n * 60 + Number(part), 0);
}

// ps -axo pid=,ppid=,uid=,etime=,pcpu=,command= → [{pid, ppid, uid, age (seconds), cpu (%), command}]
export function parsePs(text) {
  return text.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), age: etimeSeconds(m[4]), cpu: Number(m[5]), command: m[6] }] : [];
  });
}

// A command as a row shows it: its program's name without its folder (an app's name inside its bundle), the home
// folder as ~, ps's escaped newlines as spaces, and at most COMMAND_LENGTH characters.
export function shortCommand(command, home = os.homedir()) {
  const app = command.match(/^\/.*?\.app\/Contents\/MacOS\/(.*)$/);
  const text = (app ? app[1] : command.replace(/^\S+/, (program) => path.basename(program)))
    .split(home).join('~').replace(/\\012/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > COMMAND_LENGTH ? `${text.slice(0, COMMAND_LENGTH - 1)}…` : text;
}

const isNode = (p) => path.basename(p.command.split(/\s/)[0]) === 'node';
const isSuite = (p) => isNode(p) && /(^|\s)--test(\s|$)/.test(p.command);
const isOrphan = (p, { uid, keep }) => p.ppid === 1 && p.uid === uid && p.age >= ORPHAN_AGE && isNode(p) && !keep.has(p.pid);

// procs: parsePs's rows. builders: Map pid → {label, board}; sessions: Map pid → {label, owner}; keep: the pids that are
// never orphans (the hub); uid: this user's. → [{key, title, rows: [{pid, cmd, age, cpu, owner}]}], GROUPS' order,
// each group's rows busiest first, without the groups that have none.
export function loadGroups(procs, { builders, sessions, keep, uid, home = os.homedir() }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const ancestors = (p) => {
    const out = [];
    for (let up = p.ppid !== p.pid && byPid.get(p.ppid); up; up = up.ppid !== up.pid && byPid.get(up.ppid)) out.push(up);
    return out;
  };
  const groupOf = new Map();
  const group = (p) => {
    if (groupOf.has(p.pid)) return groupOf.get(p.pid);
    let g = null;
    if (builders.has(p.pid)) g = 'builder';
    else if (sessions.has(p.pid)) g = 'session';
    else if (isOrphan(p, { uid, keep })) g = 'orphan';
    else if (isSuite(p) && !ancestors(p).some((a) => ['suite', 'orphan'].includes(group(a)))) g = 'suite';
    groupOf.set(p.pid, g);
    return g;
  };
  // Each process's CPU goes to the nearest row at or above it.
  const cpu = new Map();
  const unheld = [];
  for (const p of procs) {
    const row = group(p) ? p : ancestors(p).find(group);
    if (row) cpu.set(row.pid, (cpu.get(row.pid) || 0) + p.cpu);
    else unheld.push(p);
  }
  const ownerOf = (p) => {
    const up = ancestors(p).find((a) => ['builder', 'session'].includes(group(a)));
    return up ? (builders.get(up.pid) || sessions.get(up.pid)).label : NO_OWNER;
  };
  const rowOf = (p, g) => ({
    pid: p.pid, age: p.age, cpu: Math.round((g === 'other' ? p.cpu : cpu.get(p.pid)) * 10) / 10,
    cmd: g === 'builder' ? builders.get(p.pid).label : g === 'session' ? sessions.get(p.pid).label : shortCommand(p.command, home),
    owner: g === 'builder' ? builders.get(p.pid).board : g === 'session' ? sessions.get(p.pid).owner : g === 'other' ? '' : g === 'orphan' ? NO_OWNER : ownerOf(p),
  });
  const busiest = (a, b) => b.cpu - a.cpu;
  const rows = {
    ...Object.fromEntries(GROUPS.slice(0, -1).map(([g]) => [g, procs.filter((p) => group(p) === g).map((p) => rowOf(p, g)).sort(busiest)])),
    other: unheld.filter((p) => p.cpu >= OTHER_CPU).map((p) => rowOf(p, 'other')).sort(busiest).slice(0, OTHER_ROWS),
  };
  return GROUPS.filter(([g]) => rows[g].length).map(([key, title]) => ({ key, title, rows: rows[key] }));
}

// Map pid → {label: "<card id> <kind>", board: its board's title} for every board's open builder and planner records.
export async function boardBuilders(manifest) {
  const found = new Map();
  for (const b of listBoards(manifest)) {
    for (const r of await openBoardBuilders(b.dir).catch(() => [])) {
      if (r.pid) found.set(r.pid, { label: `${r.key.split('/').pop()} ${r.kind || 'build'}`, board: b.title || b.route });
    }
  }
  return found;
}

// Map pid → {label, owner} for every Claude Code session record: a board's own session by its board's title, as its
// orchestrator; any other by its name or its folder's.
export function claudeSessions(manifest, records = sessionRecords()) {
  const owners = new Map(listBoards(manifest).filter((b) => b.owner?.session).map((b) => [b.owner.session, b.title || b.route]));
  return new Map(records.map((r) => [r.pid, owners.has(r.sessionId)
    ? { label: owners.get(r.sessionId), owner: 'orchestrator' }
    : { label: r.name || path.basename(r.cwd || '') || 'Claude', owner: r.kind === 'bg' ? 'background session' : 'session' }]));
}

// The groups now, or null when ps gave no answer in time.
async function groupsNow({ ps = () => runPs(PS_COLUMNS), builders, sessions, keep = new Set([process.pid]), uid = process.getuid(), home = os.homedir() }) {
  const text = ps();
  return text === null ? null : loadGroups(parsePs(text), { builders: await builders, sessions: await sessions, keep, uid, home });
}

// What /_hub/machine.json serves: {load, cores, average (of the samples, null without any), samples: [{at, load}],
// groups (loadGroups', or null when ps gave no answer)}.
export async function machineLoad({ reading = readMachine, samples = readMachineSamples, ...deps }) {
  const now = reading();
  const kept = samples();
  return {
    load: now.load, cores: now.cores,
    average: kept.length ? kept.reduce((n, s) => n + s.load, 0) / kept.length : null,
    samples: kept,
    groups: await groupsNow(deps),
  };
}

const refused = (status, message) => Object.assign(new Error(message), { status });

// The Stop on an orphan's row, after its confirm: reads ps afresh and sends SIGTERM to pid and every process under it,
// but only while pid still looks orphaned, so a pid that ended or was reused since the sheet drew is never signalled.
// → {stopped: [pid]}; throws 409 when it no longer looks orphaned, 503 when ps gave no answer.
export async function stopOrphan(pid, { ps = () => runPs(PS_COLUMNS), kill = process.kill, audit = (entry) => writeAudit(hubAudit(), entry), ...deps }) {
  const text = ps();
  if (text === null) throw refused(503, "ps gave no answer in time, as happens on a busy host, so nothing was stopped. Try again in a moment.");
  const procs = parsePs(text);
  const groups = loadGroups(procs, { ...deps, builders: await deps.builders, sessions: await deps.sessions, keep: deps.keep ?? new Set([process.pid]), uid: deps.uid ?? process.getuid() });
  const row = groups.find((g) => g.key === 'orphan')?.rows.find((r) => r.pid === pid);
  if (!row) throw refused(409, 'That process no longer looks orphaned, so it was not stopped.');
  const stopped = [pid];
  for (let i = 0; i < stopped.length; i++) stopped.push(...procs.filter((p) => p.ppid === stopped[i]).map((p) => p.pid));
  for (const each of stopped) { try { kill(each, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  audit({ call: 'machine-stop', result: 'stopped', reason: `Stopped ${row.cmd} (pid ${pid}, ${stopped.length - 1} under it) from the Hub row's load sheet.`, inputs: { pid, stopped } });
  return { stopped };
}
