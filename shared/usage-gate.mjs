import os from 'node:os';
import { usageReader } from '../hub/usage.mjs';
import { readSettingsFile, writeSettingsFile, readCodexShare } from '../hub/push.mjs';
import { codexStatusReader } from './codex.mjs';

export const validPauseAt = (value) => Number.isInteger(value) && value >= 50 && value <= 100 && value % 5 === 0;
const timeOf = (now) => Number(now);
const windows = ['five_hour', 'seven_day'];

export function usageGate({ claude, codex, pauseAt = 90, keepGoing, now = Date.now() } = {}) {
  const line = validPauseAt(pauseAt) ? pauseAt : 90;
  const past = (reading) => line === 100 ? null : windows.find((key) => {
    const w = reading?.[key];
    return w?.state === 'live' && Number.isFinite(w.used_percentage) && w.used_percentage >= line
      && (!w.resets_at || Date.parse(w.resets_at) > timeOf(now));
  }) || null;
  const details = (reading, window) => ({ window, used: window ? reading[window].used_percentage : null, resets_at: window ? reading[window].resets_at : null });
  const window = past(claude);
  const hit = details(claude, window);
  // A window's reported reset can drift by seconds between readings; a later window's reset is hours away.
  const going = window && keepGoing?.window === window && Math.abs(Date.parse(keepGoing.until) - Date.parse(hit.resets_at)) <= 300_000
    && timeOf(now) < Date.parse(keepGoing.until);
  const codexWindow = past(codex);
  return { pause_at: line, state: window ? going ? 'going' : 'paused' : 'normal', ...hit, codex: { past: Boolean(codexWindow), ...details(codex, codexWindow) } };
}

const readers = new Map();
export function readUsageGate({ home = os.homedir(), now = Date.now() } = {}) {
  let reader = readers.get(home);
  if (!reader) {
    reader = { now: timeOf(now) };
    reader.usage = usageReader({ home, now: () => reader.now });
    reader.codex = codexStatusReader({ home, now: () => reader.now });
    readers.set(home, reader);
  }
  reader.now = timeOf(now);
  const settings = readSettingsFile(home);
  return usageGate({ ...reader.usage({ codexShare: readCodexShare(reader.codex(), home) }), pauseAt: settings.pauseAt, keepGoing: settings.keepGoing, now });
}

export function setPauseAt(value, { home = os.homedir() } = {}) {
  if (!/^(?:50|55|60|65|70|75|80|85|90|95|100)$/.test(String(value))) throw Object.assign(new Error('pause-at takes 50..100 in steps of 5'), { status: 400 });
  writeSettingsFile({ ...readSettingsFile(home), pauseAt: Number(value) }, home);
}

export function setKeepGoing(value, { home = os.homedir(), now = Date.now() } = {}) {
  if (!['on', 'off'].includes(value)) throw Object.assign(new Error('keep-going takes on or off'), { status: 400 });
  const settings = readSettingsFile(home);
  if (value === 'on') {
    const gate = readUsageGate({ home, now });
    if (gate.state !== 'paused') throw Object.assign(new Error('Nothing is paused.'), { status: 409 });
    settings.keepGoing = { window: gate.window, until: gate.resets_at };
  } else delete settings.keepGoing;
  writeSettingsFile(settings, home);
}

export const heldUsageEvent = (line) => {
  try { return ['github-change', 'check-github', 'card-unblocked'].includes(JSON.parse(line).kind); } catch { return false; }
};

export const pauseReason = (gate) => `Work is paused: Claude's ${gate.window === 'five_hour' ? '5-hour' : 'weekly'} usage is at ${Math.round(gate.used)}%. Resumes at ${gate.resets_at}. The owner can tap Keep going on the Hub page.`;
