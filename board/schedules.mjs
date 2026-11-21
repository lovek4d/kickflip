// Schedules (docs/adr/2026-11-21-2300-a-schedule-files-a-quick-build-on-a-cadence.md): plain-English instructions a
// board files as a task on a cadence. Each lives in board.json's `schedules` as {id, text, cadence, due_at, last?,
// fired_at?, skipped?}: due_at is when it fires next, last the key of the task its last fire filed, and skipped
// {at, key} the fire it last skipped because that task was not Done. The orchestrator adds one with `schedule add`;
// Board Settings lists, edits and removes them; the board server's minute fires those due (fireSchedules).
import { appendEvent } from '../hub/boards.mjs';
import { fail, text, domId } from './checks.mjs';
import { fileAsk } from './asks.mjs';
import { askCardOf } from './cards.mjs';
import { boardTarget, readBoardJSON, writeBoardJSON } from './settings.mjs';

// The shortest `every`, so a schedule can't flood the board with tasks.
export const MIN_EVERY_MINUTES = 15;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAYS = [1, 2, 3, 4, 5];
export const CADENCE_WORDS = '"every <n>m", "every <n>h" or "at HH:MM [daily|weekdays|mon,wed,…]"';

// A cadence's words → {every: minutes} or {at: 'HH:MM', days: [0–6, Sunday 0]}. Refuses anything else, and cron.
export function parseCadence(words) {
  const said = text(words, 'the cadence').toLowerCase().replace(/\s+/g, ' ');
  const every = said.match(/^every (\d+) ?(m|h)$/);
  if (every) {
    const minutes = Number(every[1]) * (every[2] === 'h' ? 60 : 1);
    if (minutes < MIN_EVERY_MINUTES) fail(`a schedule runs at most every ${MIN_EVERY_MINUTES}m`);
    return { every: minutes };
  }
  const at = said.match(/^at ([01]\d|2[0-3]):([0-5]\d)(?: (.+))?$/);
  if (!at) fail(`the cadence "${words}" must be ${CADENCE_WORDS}`);
  const on = at[3] ?? 'daily';
  const days = on === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : on === 'weekdays' ? WEEKDAYS
    : on.split(',').map((d) => DAYS.indexOf(d.trim()));
  if (days.includes(-1)) fail(`the days in "${words}" must be daily, weekdays or a list such as mon,wed,fri`);
  return { at: `${at[1]}:${at[2]}`, days: [...new Set(days)].sort() };
}

// The first time after `after` the cadence falls due: `every` counts from `after`, `at` is the next listed day's HH:MM
// on the host's clock.
export function nextDue(words, after) {
  const cadence = parseCadence(words);
  if (cadence.every) return new Date(after.getTime() + cadence.every * 60_000);
  const [h, m] = cadence.at.split(':').map(Number);
  for (let day = 0; day <= 7; day++) {
    const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + day, h, m);
    if (d > after && cadence.days.includes(d.getDay())) return d;
  }
  throw new Error(`no day in ${words}`);
}
// A new or re-cadenced schedule's first fire: an `every` at once, an `at` at its next time.
const firstDue = (words, now) => (parseCadence(words).every ? now : nextDue(words, now));

export const schedulesOf = (cfg) => (Array.isArray(cfg?.schedules) ? cfg.schedules : []);
export const readSchedules = async (site) => schedulesOf(await readBoardJSON(site));

// change(list) → the new list; refuses an unknown id.
const writeSchedules = (site, change) => writeBoardJSON(site, (cfg) => {
  const schedules = change(schedulesOf(cfg));
  return { set: { schedules: schedules.length ? schedules : undefined }, schedules };
});
const known = (list, id) => list.find((s) => s.id === id) || fail(`this board has no schedule "${id}"`);

export function addSchedule(site, id, { text: words, cadence }, now = new Date()) {
  domId(id, 'the schedule id');
  const schedule = { id, text: text(words, '--text'), cadence: text(cadence, '--cadence'), due_at: firstDue(cadence, now).toISOString() };
  return writeSchedules(site, (list) => {
    if (list.some((s) => s.id === id)) fail(`this board already has a schedule "${id}"; change it with schedule set`);
    return [...list, schedule];
  });
}

// Rewords a schedule or changes its cadence, which restarts its count from now; its pointer stays.
export function setSchedule(site, id, { text: words, cadence }, now = new Date()) {
  if (words === undefined && cadence === undefined) fail('schedule set takes --text, --cadence or both');
  const changes = { ...(words !== undefined ? { text: text(words, '--text') } : {}) };
  if (cadence !== undefined) Object.assign(changes, { cadence: text(cadence, '--cadence'), due_at: firstDue(cadence, now).toISOString() });
  return writeSchedules(site, (list) => {
    const old = known(list, id);
    return list.map((s) => (s === old ? { ...s, ...changes } : s));
  });
}

export const removeSchedule = (site, id) => writeSchedules(site, (list) => {
  const old = known(list, id);
  return list.filter((s) => s !== old);
});

// The schedules as `schedule list` prints them, one line each.
export async function listSchedules(site) {
  return { lines: (await readSchedules(site)).map((s) => [s.id, s.cadence, `next ${s.due_at}`, s.last ? `last ${s.last}` : 'never fired', s.text].join(' · ')) };
}

// docs/adr/2026-11-21-2300-a-schedule-files-a-quick-build-on-a-cadence.md
// Fires every schedule due at `now`, given the board's built cards (items, each {key, lane}). A schedule whose last task
// is on the board short of Done skips this fire and notes it; else it files its text as an Implement ask, which triage
// stages, related to its last task when that is still on the board, and points at the new task. Either way its next
// fire is one cadence on from now, so fires missed while the host slept or the board was paused come as one.
// The caller holds it while the board is paused. → the lines it did.
export async function fireSchedules(site, items, now = new Date()) {
  const lines = [];
  for (const s of await readSchedules(site)) {
    if (now < new Date(s.due_at)) continue;
    const lastCard = s.last && items.find((i) => i.key === s.last);
    const update = { due_at: nextDue(s.cadence, now).toISOString() };
    if (lastCard && lastCard.lane !== 'done') {
      update.skipped = { at: now.toISOString(), key: s.last };
      lines.push(`schedule ${s.id}: skipped, ${s.last} is not Done`);
    } else {
      const id = await appendEvent(boardTarget(site), 'ask', { text: s.text, quick: true, asked: { by: 'schedule', schedule: s.id }, ...(lastCard ? { links: { related: [s.last] } } : {}) });
      const key = await fileAsk(site, id) || (await askCardOf(site, id)).key;
      Object.assign(update, { last: key, fired_at: now.toISOString(), skipped: undefined });
      lines.push(`schedule ${s.id}: filed ${key}`);
    }
    // Written onto the list as it is now, so an edit or removal made meanwhile stays.
    await writeSchedules(site, (list) => list.map((x) => (x.id === s.id ? { ...x, ...update } : x)));
  }
  return { lines };
}
