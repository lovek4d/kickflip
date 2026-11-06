import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageReader } from '../hub/usage.mjs';
import { readSettingsFile, writeSettingsFile, readCodexShare, readClaudeModel } from '../hub/push.mjs';
import { FOREVER, durationEnd, storedEnd } from '../hub/duration.mjs';
import { codexStatus, codexStatusReader, effectiveCodexShare } from './codex.mjs';
import { MACHINE_NORMAL, readMachineState } from './machine-gate.mjs';

export const validPauseAt = (value) => Number.isInteger(value) && value >= 50 && value <= 100 && value % 5 === 0;
const timeOf = (now) => Number(now);
const windows = ['five_hour', 'seven_day'];

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
// A manual pause's stored end (settings.json's paused_until for the hub, board.json's for a board) while it is still
// ahead: an ISO time, or FOREVER, which lasts until the owner resumes it.
const pausedUntil = (stored, now) => (stored === FOREVER || (typeof stored === 'string' && Date.parse(stored) > timeOf(now)) ? stored : null);

// When a Pause hub or Pause board choice made at `now` ends, as it is stored (an ISO time or FOREVER), or null for off:
// the snooze picker's chips, Forever included, and Custom (hub/duration.mjs). Throws {status: 400} for any other choice.
export function pauseEnd(choice, now = new Date()) {
  if (choice === 'off') return null;
  const end = durationEnd(new Date(timeOf(now)), choice);
  if (!end) throw Object.assign(new Error('A pause ends after now and within 30 days: <n>m, <n>h, <n>d, <n>w, forever or a date and time; or off.'), { status: 400 });
  return storedEnd(end);
}

// A manual pause's end in words: `until <iso>`, or until the owner resumes it for FOREVER.
export const pauseUntilWords = (end) => (end === FOREVER ? 'until the owner resumes it' : `until ${end}`);

// hubPause and boardPause are the manual pauses' stored ends (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md):
// either, while ahead, pauses Claude and Codex work alike, over the usage pause and Keep going, the hub's first.
// machine is the Mac's state (machine-gate.mjs readMachineState), which the gate carries as it is: a busy Mac holds
// all new work (holdsWork, heldFor) and leaves state, the usage pause's, alone.
export function usageGate({ claude, codex, pauseAt = 90, keepGoing, hubPause, boardPause, machine = MACHINE_NORMAL, now = Date.now() } = {}) {
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
  const codexDetails = { past: Boolean(codexWindow), ...details(codex, codexWindow) };
  const manual = pausedUntil(hubPause, now) ? 'hub' : pausedUntil(boardPause, now) ? 'board' : null;
  if (manual) return { pause_at: line, state: 'paused', manual, window: null, used: null, resets_at: pausedUntil(manual === 'hub' ? hubPause : boardPause, now), codex: codexDetails, machine };
  return { pause_at: line, state: window ? going ? 'going' : 'paused' : 'normal', manual: null, ...hit, codex: codexDetails, machine };
}

const readBoardJson = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8')) || {}; } catch { return {}; } };
// The end of Pause board on the board at dir, while it is ahead, else null.
export const boardPausedUntil = (dir, now = Date.now()) => pausedUntil(readBoardJson(dir).paused_until, now);

// dir is a board's site dir, whose own pause it reads too; without it only the hub's.
const readers = new Map();
export function readUsageGate({ home = os.homedir(), now = Date.now(), dir = null } = {}) {
  let reader = readers.get(home);
  if (!reader) {
    reader = { now: timeOf(now) };
    reader.usage = usageReader({ home, now: () => reader.now });
    reader.codex = codexStatusReader({ home, now: () => reader.now });
    readers.set(home, reader);
  }
  reader.now = timeOf(now);
  const settings = readSettingsFile(home);
  return usageGate({ ...reader.usage({ codexShare: readCodexShare(reader.codex(), home) }), pauseAt: settings.pauseAt, keepGoing: settings.keepGoing,
    hubPause: settings.paused_until, boardPause: dir ? boardPausedUntil(dir, now) : null, machine: readMachineState(home), now });
}

// Pause hub: a pauseEnd choice, or off. Settings writes keep other keys. → the stored end, or null.
export function setHubPause(choice, { home = os.homedir(), now = new Date() } = {}) {
  const end = pauseEnd(choice, now);
  const { paused_until: _, ...rest } = readSettingsFile(home);
  writeSettingsFile(end ? { ...rest, paused_until: end } : rest, home);
  return end;
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
  try { return ['github-change', 'check-github', 'card-unblocked', 'overnight-triage', 'pr-review', 'owner-check-broken'].includes(JSON.parse(line).kind); } catch { return false; }
};

// Who builds a card, codex or claude: Codex while it is usable, the Codex share in effect is auto or always, and Codex is
// under the pause line, else Claude (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md), with the
// model claudePick gives. card is the card's wave entry, whose size and model Auto reads. inputs is what the pick read,
// up to the point it decided, for the audit log (shared/audit.mjs).
// → {kind, model?, reason, inputs}
export function builderPick({ home = os.homedir(), now = Date.now(), card = {} } = {}) {
  const status = codexStatus({ home });
  const inputs = { codex: status.reason ?? 'usable', claudeModel: readClaudeModel(home), size: card.size ?? null, cardModel: card.model ?? null };
  const claude = (why) => { const { model, reason } = claudePick(inputs.claudeModel, card); return { kind: 'claude', model, reason: `${why} ${reason}`, inputs }; };
  if (!status.usable) return claude(status.words);
  inputs.codexShare = effectiveCodexShare(readSettingsFile(home).codexShare, status);
  if (inputs.codexShare === 'off') return claude('Codex share is off.');
  const gate = readUsageGate({ home, now });
  Object.assign(inputs, { pauseAt: gate.pause_at, codexUsage: gate.codex });
  if (gate.codex.past) return claude(`Codex is at ${Math.round(gate.codex.used)}%, past the ${gate.pause_at}% line until ${gate.codex.resets_at}.`);
  return { kind: 'codex', reason: `Codex share is ${inputs.codexShare} and Codex is under the ${gate.pause_at}% line.`, inputs };
}

// The hub's Claude model (hub/push.mjs readClaudeModel) forces Opus or Sonnet; Auto takes the card's own model, else
// Sonnet for a card sized small and Opus for the rest
// (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md). → {model, reason}
const NAMES = { opus: 'Opus', sonnet: 'Sonnet' };
function claudePick(setting, card) {
  if (setting !== 'auto') return { model: setting, reason: `Claude model is ${NAMES[setting]}.` };
  if (card.model) return { model: card.model, reason: `Claude model is Auto and the card asks for Claude ${NAMES[card.model]}.` };
  return card.size === 'small' ? { model: 'sonnet', reason: 'Claude model is Auto and the card is small.' } : { model: 'opus', reason: "Claude model is Auto and the card isn't small." };
}

const MANUAL_WORDS = { hub: ['the hub', 'Pause hub in Hub settings'], board: ['this board', 'Pause board in Board settings'] };
// A pause is worded before a busy Mac.
export const pauseReason = (gate) => (gate.manual
  ? `Work is paused: the owner paused ${MANUAL_WORDS[gate.manual][0]} ${pauseUntilWords(gate.resets_at)}. ${MANUAL_WORDS[gate.manual][1]} resumes it.`
  : gate.state === 'paused' ? usagePauseReason(gate) : busyReason(gate));
// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md: the refusal, and the thread line on a card whose launch it holds.
const busyReason = (gate) => `Work is held: this Mac is busy (${gate.machine.reason}). It starts again when the Mac eases.`;
export const MACHINE_HELD_LINE = 'Held: this Mac is busy. It starts again when the Mac eases.';
// Whether gate holds all new work: a pause (usage or manual) or a busy Mac.
export const holdsWork = (gate) => gate.state === 'paused' || gate.machine.state === 'busy';
// The watcher's line while paused: `usage paused <iso> <window> <used>%`, or `usage paused <iso|forever> manual hub|board`.
export const pausedLine = (gate) => `usage paused ${gate.resets_at} ${gate.manual ? `manual ${gate.manual}` : `${gate.window} ${gate.used}%`}`;
const usagePauseReason = (gate) => `Work is paused: Claude's ${windowWord(gate.window)} usage is at ${Math.round(gate.used)}%. Resumes at ${gate.resets_at}. The owner can tap Keep going on the Hub page.`;

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
// Whether gate holds an agent of kind: Codex while past its line, any other kind (Claude, and the planners, which run
// as Claude) while Claude's work is paused; every kind while the owner paused it by hand or the Mac is busy, with no
// override. pauseReasonFor words the hold.
export const heldFor = (gate, kind) => Boolean(gate.manual) || gate.machine.state === 'busy' || (kind === 'codex' ? gate.codex.past : gate.state === 'paused');
const windowWord = (window) => (window === 'five_hour' ? '5-hour' : 'weekly');
export const pauseReasonFor = (gate, kind) => (kind === 'codex' && !gate.manual && gate.codex.past
  ? `Codex is paused: its ${windowWord(gate.codex.window)} usage is at ${Math.round(gate.codex.used)}%, past the ${gate.pause_at}% line. Resumes at ${gate.codex.resets_at}.`
  : kind === 'codex' && !gate.manual ? busyReason(gate) : pauseReason(gate));
