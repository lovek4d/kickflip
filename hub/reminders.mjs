// "Remind me to": one-shot timed pushes the owner asks the orchestrator for, stored in the hub, not on a board
// (docs/adr/2026-11-26-2200-remind-me-to-is-a-hub-stored-one-shot-timed-push.md). They live in <home>/.claude/kickflip/reminders.json
// as [{id, at: ISO, text}], so a hub restart loses none. The hub's 15 s clock (shared/polls.mjs reminders) runs sendDue:
// each reminder at or past its time goes once, as a `reminder` push carrying only its text, urgent so quiet hours and a
// snooze don't hold it (notifications off still drops it), and is then removed. One no device took stays for the next run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deliver } from './push.mjs';
import { durationEnd } from './duration.mjs';
import { withFileLock } from './locks.mjs';
import { bellItem } from '../board/cards.mjs';
import { refOf } from '../board/domain.mjs';

export const remindersFile = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'reminders.json');

// The stored reminders, oldest time first; [] when the file is missing or unreadable.
export function readReminders(home = os.homedir()) {
  try {
    const list = JSON.parse(fs.readFileSync(remindersFile(home), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

const change = (home, fn) => withFileLock(remindersFile(home), () => {
  const next = fn(readReminders(home)).sort((a, b) => a.at.localeCompare(b.at));
  fs.mkdirSync(path.dirname(remindersFile(home)), { recursive: true });
  const tmp = `${remindersFile(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, remindersFile(home));
});

// at: a duration.mjs durationEnd choice (<n>m, <n>h, <n>d, <n>w or an ISO date and time), at most 30 days on.
// → {reminder: {id, at, text}} or {error}.
export async function addReminder({ at, text }, { now = new Date(), home = os.homedir() } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'a reminder needs --text, what to remind the owner of' };
  const end = durationEnd(now, at);
  if (!end || end === 'forever') return { error: '--at is a time ahead, at most 30 days on: <n>m, <n>h, <n>d, <n>w, or an ISO date and time such as 2026-11-27T16:00' };
  const reminder = { id: crypto.randomUUID(), at: end.toISOString(), text: body };
  await change(home, (list) => [...list, reminder]);
  return { reminder };
}

// Sends each reminder due at `now`. → the ids sent.
export async function sendDue({ now = new Date(), home = os.homedir(), fetch = globalThis.fetch } = {}) {
  const sent = [];
  for (const r of readReminders(home).filter((x) => new Date(x.at) <= now)) {
    const out = await deliver({ title: r.text, url: '/', tag: `reminder-${r.id}` }, { kind: 'reminder', urgent: true, at: now, home, fetch });
    // urgent resolves to {sent} even when every device refused; noDevice and dropped are final.
    if (out.sent && !out.sent.some((x) => x.status >= 200 && x.status < 300)) continue;
    sent.push(r.id);
  }
  if (sent.length) await change(home, (list) => list.filter((x) => !sent.includes(x.id)));
  return sent;
}

// docs/adr/2026-11-27-1500-hub-settings-lists-and-cancels-every-reminder.md
// Every reminder the hub holds, for Hub settings' Reminders sheet: each board's cards with a remind_when (done, needs-you
// or every-stage, the bell), a board with none left out, and the stored timed ones, soonest first.
// boards: listBoards' boards. → {boards: [{route, title, rows: [{key, ref, title, when}]}], timed: [{id, at, text}]}
export function listReminders(boards, { home = os.homedir() } = {}) {
  return {
    boards: boards.map(({ route, title, files, tickets }) => ({ route, title,
      rows: files.flatMap(({ slug, itemFile }) => itemFile.items.filter((it) => it.remind_when)
        .map((it) => ({ key: `${slug}/${it.id}`, ref: refOf(itemFile, it, tickets), title: it.title, when: it.remind_when }))) })).filter((b) => b.rows.length),
    timed: readReminders(home),
  };
}

// The owner's Cancel on a sheet row: {id} a timed reminder, or {route, key} a card's, taken off as the lit bell's tap does
// (cards.mjs bellItem, the owner's Bell off line). → whether it was there to cancel.
export async function cancelReminder({ id, route, key }, { boards, home = os.homedir() }) {
  if (id !== undefined) {
    let found = false;
    await change(home, (list) => list.filter((r) => (r.id === id ? !(found = true) : true)));
    return found;
  }
  const board = boards.find((b) => b.route === route);
  return Boolean(board && await bellItem(board.dir, key, false));
}
