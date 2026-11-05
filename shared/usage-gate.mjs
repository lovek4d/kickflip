import os from 'node:os';
import { usageReader } from '../hub/usage.mjs';
import { readSettingsFile, writeSettingsFile, readCodexShare, readClaudeModel } from '../hub/push.mjs';
import { codexStatus, codexStatusReader, effectiveCodexShare } from './codex.mjs';

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

export const pauseReason = (gate) => `Work is paused: Claude's ${windowWord(gate.window)} usage is at ${Math.round(gate.used)}%. Resumes at ${gate.resets_at}. The owner can tap Keep going on the Hub page.`;

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
// Whether gate holds an agent of kind: Codex while past its line, any other kind (Claude, and the planners, which run
// as Claude) while Claude's work is paused. pauseReasonFor words the hold.
export const heldFor = (gate, kind) => (kind === 'codex' ? gate.codex.past : gate.state === 'paused');
const windowWord = (window) => (window === 'five_hour' ? '5-hour' : 'weekly');
export const pauseReasonFor = (gate, kind) => (kind === 'codex'
  ? `Codex is paused: its ${windowWord(gate.codex.window)} usage is at ${Math.round(gate.codex.used)}%, past the ${gate.pause_at}% line. Resumes at ${gate.codex.resets_at}.`
  : pauseReason(gate));
