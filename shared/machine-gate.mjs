// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md
// Whether this Mac is busy: memory pressure critical, or a 1-minute load of HOLD_LOAD× its cores or more. A busy Mac
// stays busy until pressure is warn or lower and load is under RELEASE_LOAD× its cores, so it doesn't flap. The hub's
// tick reads the Mac and keeps ~/.claude/kickflip/machine-state.json; every other reader reads that file through the one
// gate (usage-gate.mjs readUsageGate), which holds all new work while it reads busy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { audit, hubAudit } from './audit.mjs';

export const HOLD_LOAD = 4;
export const RELEASE_LOAD = 3;
const READING_EVERY = 10 * 60_000;
export const MACHINE_NORMAL = Object.freeze({ state: 'normal', reason: null });

// sysctl kern.memorystatus_vm_pressure_level's levels; null for none, as off macOS.
const PRESSURES = { 1: 'normal', 2: 'warn', 4: 'critical' };
export const pressureOf = (level) => PRESSURES[level] ?? null;

// → {load: the 1-minute load average, cores, pressure: normal | warn | critical | null}
export function readMachine() {
  let level = null;
  try { level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  return { load: os.loadavg()[0], cores: os.cpus().length, pressure: pressureOf(level) };
}

// The Mac's state after reading, from was, the state before it. → busy | normal
export function machineState(was, { load, cores, pressure }) {
  const line = (was === 'busy' ? RELEASE_LOAD : HOLD_LOAD) * cores;
  return pressure === 'critical' || load >= line ? 'busy' : 'normal';
}

export const machineFile = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'machine-state.json');
const readFile = (home) => { try { return JSON.parse(fs.readFileSync(machineFile(home), 'utf8')); } catch { return null; } };

// The state the hub's tick last kept: {state: busy, reason, since: when it turned busy} or MACHINE_NORMAL, also without a file.
export function readMachineState(home = os.homedir()) {
  const kept = readFile(home);
  return kept?.state === 'busy' ? { state: 'busy', reason: kept.reason, since: kept.since } : MACHINE_NORMAL;
}

// The hub's tick: reads the Mac, keeps the state file, and puts each change and one reading every 10 minutes in the
// hub's audit log (shared/audit.mjs), so the thresholds can be checked against what this Mac reads.
export function checkMachine({ home = os.homedir(), reading = readMachine(), now = new Date() } = {}) {
  const previous = readFile(home);
  const was = previous?.state ?? 'normal';
  const state = machineState(was, reading);
  const reason = state === 'busy' ? (reading.pressure === 'critical' ? 'memory pressure critical' : 'load high') : null;
  const inputs = { reading, previous: previous?.state ?? null, hold: HOLD_LOAD, release: RELEASE_LOAD };
  const load = `1-minute load ${reading.load.toFixed(1)}`;
  const changed = state !== was;
  const due = !previous?.logged_at || now.getTime() - Date.parse(previous.logged_at) >= READING_EVERY;
  if (changed && state === 'busy') {
    const why = reading.pressure === 'critical' ? 'memory pressure is critical' : `${load} is at least ${HOLD_LOAD}× its ${reading.cores} cores`;
    audit(hubAudit(home), { call: 'machine-busy', result: state, reason: `The host is busy: ${why}, so no new work starts.`, inputs }, { now });
  } else if (changed) {
    audit(hubAudit(home), { call: 'machine-eased', result: state, reason: `Memory pressure is ${reading.pressure ?? 'unread'} and ${load} is under ${RELEASE_LOAD}× its ${reading.cores} cores, so new work starts again.`, inputs }, { now });
  } else if (due) {
    audit(hubAudit(home), { call: 'machine-reading', result: state, reason: `Memory pressure is ${reading.pressure ?? 'unread'} and ${load} on ${reading.cores} cores.`, inputs }, { now });
  }
  const since = state === 'busy' ? (was === 'busy' && previous.since) || now.toISOString() : null;
  const next = { state, reason, since, at: now.toISOString(), reading, logged_at: changed || due ? now.toISOString() : previous.logged_at };
  const file = machineFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next) + '\n');
  fs.renameSync(tmp, file);
  return next;
}
