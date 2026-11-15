// Overnight work (docs/adr/2026-11-15-0700-quiet-hours-list-the-overnight-work-each-job-on-by-default.md): the jobs the
// hub runs at night, each a row in the Quiet hours modal's Overnight work group with its time, its last run and a toggle.
// Every job is on unless settings.json's `overnight` stores {<id>: false}. Overnight work starts together at the middle of
// quiet hours (schedule.mjs quietMiddle); the daily wake keeps their end. A job's code reads overnightOn before it runs.
import { readSettingsFile, writeSettingsFile } from './push.mjs';
import { readJSON, wakeStateFile } from './boards.mjs';

// Each job: id; title; icon, a ui-hub.js tile; does({middle, end}), its line, given the start and end of the window as
// words; and last(), its last run, {at: ISO time, failed: what failed or '', href?: the card or log a failure links},
// or null when it never ran.
export const JOBS = [
  {
    id: 'wake', title: 'Daily wake', icon: 'calendar',
    does: (w) => `Wakes every board once at ${w.end}, when quiet hours end.`,
    last() {
      const last = readJSON(wakeStateFile(), {}).last;
      return last ? { at: last.at, failed: last.failed?.length ? `failed on ${last.failed.join(', ')}` : '' } : null;
    },
  },
];

export const overnightOn = (id, file = readSettingsFile()) => file.overnight?.[id] !== false;

// Throws {status: 400} for a job that isn't in JOBS. On is the default, so turning a job on removes its key.
export function setOvernight(id, on) {
  if (!JOBS.some((j) => j.id === id)) throw Object.assign(new Error(`No overnight job called ${id}.`), { status: 400 });
  const { overnight = {}, ...rest } = readSettingsFile();
  const { [id]: _, ...others } = overnight;
  const next = on ? others : { ...others, [id]: false };
  writeSettingsFile(Object.keys(next).length ? { ...rest, overnight: next } : rest);
}

// The jobs as views.mjs settingsView's overnight: each with whether it's on and its last run.
export function overnightJobs() {
  const file = readSettingsFile();
  return JOBS.map(({ last, ...job }) => ({ ...job, on: overnightOn(job.id, file), last: last() }));
}
