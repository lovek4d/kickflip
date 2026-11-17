// Overnight work (docs/adr/2026-11-15-0700-quiet-hours-list-the-overnight-work-each-job-on-by-default.md): the jobs the
// hub runs at night, each a row in the Quiet hours modal's Overnight work group with its time, its last run and a toggle.
// Every job is on unless settings.json's `overnight` stores {<id>: false}. Overnight work starts together at the middle of
// quiet hours (schedule.mjs quietMiddle); the daily wake keeps their end. A job's code reads overnightOn before it runs; a board
// server's overnight triage reads the `triage` job.
import { read as readSettingsFile, update as updateSettings } from '../shared/hub-settings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { listBoards, readJSON, suiteStateFile, wakeStateFile } from './boards.mjs';

// Each job: id; title; icon, a ui-hub.js tile; does({middle, end}), its line, given the start and end of the window as
// words; and last(boards), its last run, {at: ISO time, failed: what failed or '', href?: the card or log a failure
// links}, or null when it never ran.
export const JOBS = [
  {
    id: 'triage', title: 'Triage overnight', icon: 'moon',
    does: (w) => `Once a night from ${w.middle}, when two or more tasks wait on your answers, Claude merges their overlapping questions and duplicate tasks, and tidies Todo.`,
    last: (boards) => {
      const at = boards.map(lastTriage).filter(Boolean).sort().at(-1);
      return at ? { at, failed: '' } : null;
    },
  },
  {
    id: 'wake', title: 'Daily wake', icon: 'calendar',
    does: (w) => `Wakes every board once at ${w.end}, when quiet hours end.`,
    last() {
      const last = readJSON(wakeStateFile(), {}).last;
      return last ? { at: last.at, failed: last.failed?.length ? `failed on ${last.failed.join(', ')}` : '' } : null;
    },
  },
  {
    // nightly-suite.mjs runNightlySuite; a failure links the first task it filed.
    id: 'suite', title: 'Nightly full suite', icon: 'tests',
    does: (w) => `Runs every board's tests on its main at ${w.middle}, one board at a time, and files a task on a board whose main fails.`,
    last() {
      const last = readJSON(suiteStateFile(), {}).last;
      if (!last) return null;
      const routes = (pick) => last.runs.filter(pick).map((r) => r.route).join(', ');
      const failed = [routes((r) => !r.ok && !r.error) && `failed on ${routes((r) => !r.ok && !r.error)}`, routes((r) => r.error) && `couldn't run on ${routes((r) => r.error)}`].filter(Boolean).join('; ');
      const href = last.runs.find((r) => r.href)?.href;
      return { at: last.at, failed, ...(href ? { href } : {}) };
    },
  },
];

// When the board's newest overnight-triage event went out, as its ISO time, else null.
function lastTriage(board) {
  let log = '';
  try { log = fs.readFileSync(path.join(board.dir, 'data', 'events.jsonl'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const line = log.split('\n').findLast((l) => l.includes('"kind":"overnight-triage"'));
  return line ? JSON.parse(line).ts : null;
}

export const overnightOn = (id, file = readSettingsFile()) => file.overnight?.[id] !== false;

// Throws {status: 400} for a job that isn't in JOBS. On is the default, so turning a job on removes its key.
export async function setOvernight(id, on) {
  if (!JOBS.some((j) => j.id === id)) throw Object.assign(new Error(`No overnight job called ${id}.`), { status: 400 });
  await updateSettings(({ overnight = {}, ...rest }) => {
    const { [id]: _, ...others } = overnight;
    const next = on ? others : { ...others, [id]: false };
    return Object.keys(next).length ? { ...rest, overnight: next } : rest;
  });
}

// The jobs as views.mjs settingsView's overnight: each with whether it's on and its last run.
export function overnightJobs(boards = listBoards()) {
  const file = readSettingsFile();
  return JOBS.map(({ last, ...job }) => ({ ...job, on: overnightOn(job.id, file), last: last(boards) }));
}

// docs/adr/2026-11-16-0100-one-hub-triage-overnight-switch-replaces-the-board-toggle.md
// Moves the boards' old `auto_triage` to the hub's Triage overnight switch, once: on if any board had it on, else off
// (a job is otherwise on by default), and the key leaves every board.json. → {on}, or null when no board has the key.
export async function migrateTriage(boards = listBoards()) {
  const files = boards.map((b) => path.join(b.dir, 'board.json')).filter((f) => 'auto_triage' in readJSON(f, {}));
  if (!files.length) return null;
  const on = files.some((f) => readJSON(f, {}).auto_triage === true);
  await setOvernight('triage', on);
  for (const f of files) {
    const { auto_triage: _, ...rest } = readJSON(f, {});
    fs.writeFileSync(f + '.tmp', JSON.stringify(rest, null, 2) + '\n');
    fs.renameSync(f + '.tmp', f);
  }
  return { on };
}
