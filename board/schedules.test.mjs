import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { site, lines, read, board } from './board-fixture.mjs';
import { parseCadence, nextDue, fireSchedules } from './schedules.mjs';
import { threadOf, implementAsk } from './domain.mjs';
import { plainLine } from '../bin/event-lines.mjs';

// docs/adr/2026-11-21-2300-a-schedule-files-a-quick-build-on-a-cadence.md
const audit = () => site('audit');
const schedules = () => read(site('audit', 'board.json')).schedules;
const items = () => read(site('audit', 'data', 'items.json')).items;
const asks = () => (fs.existsSync(site('audit', 'data', 'events.jsonl')) ? lines(site('audit', 'data', 'events.jsonl')).filter((e) => e.kind === 'ask') : []);
const schedule = (...args) => board('schedule', ...args, '--site', 'audit');
const at = (d, hh, mm) => new Date(2026, 10, d, hh, mm);

test('Board Settings lists each schedule with its cadence, next fire, last task and a skipped fire, and edits one in place', () => {
  const ctx = vm.createContext({ BoardUI: { esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) } });
  vm.runInContext(fs.readFileSync(new URL('./public/view-settings.js', import.meta.url), 'utf8'), ctx);
  const html = (list, opts) => ctx.AppViews.settings.schedulesHtml(list, opts);
  assert.match(html([]), /No schedules on this board yet/);
  const list = [
    { id: 'news', text: 'Summarise <the> news', cadence: 'every 4h', due_at: '2026-11-21T14:00:00Z', last: 'audit/T-9', last_ref: 'T-9', skipped: { at: '2026-11-21T10:00:00Z', key: 'audit/T-9' } },
    { id: 'digest', text: 'Weekly digest', cadence: 'at 09:00 mon', due_at: '2026-11-23T09:00:00Z' },
  ];
  const shown = html(list);
  assert.match(shown, /Summarise &#60;the&#62; news/);
  assert.match(shown, /<span>every 4h<\/span><span>next [^<]+<\/span><span>last <a href="#selectedCard=audit%2FT-9">T-9<\/a><\/span><span>skipped [^<]+: its last task wasn’t Done<\/span>/);
  assert.match(shown, /<span>at 09:00 mon<\/span><span>next [^<]+<\/span><span>not fired yet<\/span><\/div>/);
  assert.equal(shown.match(/data-act="remove"/g).length, 2);
  const editing = html(list, { editing: 'digest' });
  assert.match(editing, /<textarea class="schedule-text"[^>]*>Weekly digest<\/textarea>/);
  assert.match(editing, /<input class="schedule-cadence" value="at 09:00 mon"/);
  assert.match(editing, /data-act="save"[\s\S]*data-act="cancel"/);
});

test('a cadence is every <n>m|h, at least 15m, or at HH:MM on listed days, and nothing else', () => {
  assert.deepEqual(parseCadence('every 4h'), { every: 240 });
  assert.deepEqual(parseCadence('Every 30m'), { every: 30 });
  assert.deepEqual(parseCadence('at 09:00'), { at: '09:00', days: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(parseCadence('at 09:00 weekdays'), { at: '09:00', days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseCadence('at 18:30 wed,mon'), { at: '18:30', days: [1, 3] });
  assert.throws(() => parseCadence('every 5m'), /at most every 15m/);
  assert.throws(() => parseCadence('*/30 * * * *'), /must be "every <n>m"/);
  assert.throws(() => parseCadence('at 9:00'), /must be "every <n>m"/);
  assert.throws(() => parseCadence('at 09:00 someday'), /daily, weekdays or a list/);
});

test('the next fire counts on from the given time: every from it, at to the next listed day', () => {
  // 21 Nov 2026 is a Saturday.
  assert.equal(nextDue('every 4h', at(21, 10, 0)).getTime(), at(21, 14, 0).getTime());
  assert.equal(nextDue('at 09:00', at(21, 8, 0)).getTime(), at(21, 9, 0).getTime());
  assert.equal(nextDue('at 09:00', at(21, 9, 0)).getTime(), at(22, 9, 0).getTime());
  assert.equal(nextDue('at 09:00 weekdays', at(21, 10, 0)).getTime(), at(23, 9, 0).getTime());
  assert.equal(nextDue('at 09:00 fri', at(27, 9, 1)).getTime(), at(34, 9, 0).getTime());
});

test('schedule add, set, list and rm keep the board\'s schedules in board.json', async () => {
  let r = await schedule('add', 'news', '--cadence', 'at 09:00 weekdays', '--text', 'Summarise the week\'s news on the page');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /schedule news added: at 09:00 weekdays, first fire /);
  assert.deepEqual(schedules().map((s) => [s.id, s.cadence, s.text]), [['news', 'at 09:00 weekdays', 'Summarise the week\'s news on the page']]);
  assert.equal(new Date(schedules()[0].due_at).getHours(), 9);
  assert.match((await schedule('add', 'news', '--cadence', 'every 1h', '--text', 'x')).err, /already has a schedule "news"/);
  assert.match((await schedule('add', 'fast', '--cadence', 'every 1m', '--text', 'x')).err, /at most every 15m/);
  r = await schedule('set', 'news', '--cadence', 'every 4h');
  assert.equal(r.code, 0, r.err);
  // An every cadence fires at once, then on its count.
  assert.ok(Math.abs(Date.parse(schedules()[0].due_at) - Date.now()) < 60_000);
  assert.match((await schedule('list')).out, /^news · every 4h · next .* · never fired · Summarise the week's news on the page$/m);
  assert.match((await schedule('set', 'nope', '--text', 'x')).err, /no schedule "nope"/);
  assert.match((await schedule('set', 'news')).err, /takes --text, --cadence or both/);
  assert.equal((await schedule('rm', 'news')).code, 0);
  assert.equal(schedules(), undefined);
  assert.match((await schedule('rm', 'news')).err, /no schedule "news"/);
});

test('a due fire files a staged-to-build ask from the schedule, skips while its last task isn\'t Done, then relates the next to it', async () => {
  assert.equal((await schedule('add', 'news', '--cadence', 'every 4h', '--text', 'Summarise the news on the page')).code, 0);
  const now = new Date(schedules()[0].due_at);
  const cards = () => items().map((it) => ({ key: `audit/${it.id}`, lane: it.lane }));

  // Not due yet: nothing.
  assert.deepEqual((await fireSchedules(audit(),cards(), new Date(now.getTime() - 60_000))).lines, []);
  const first = await fireSchedules(audit(),cards(), now);
  const [ask] = asks();
  assert.deepEqual([ask.data.text, ask.data.quick, ask.data.asked, ask.data.links], ['Summarise the news on the page', true, { by: 'schedule', schedule: 'news' }, undefined]);
  // An Implement ask, so triage stages it and the orchestrator judges and sizes it.
  assert.equal(implementAsk(asks(), ask.id), true);
  const card = items().find((it) => it.from_ask === ask.id);
  const key = `audit/${card.id}`;
  assert.deepEqual(first.lines, [`schedule news: filed ${key}`]);
  assert.deepEqual([schedules()[0].last, schedules()[0].fired_at], [key, now.toISOString()]);
  assert.equal(schedules()[0].due_at, new Date(now.getTime() + 4 * 3600_000).toISOString());
  assert.match(await plainLine(audit(),JSON.stringify(ask)), /from the board's schedule news received as .*, to build: item triage <its key> --title and its links and no --phase/);

  // Due again while its task is short of Done: skipped and noted, its pointer kept.
  const later = new Date(now.getTime() + 5 * 3600_000);
  assert.deepEqual((await fireSchedules(audit(),cards(), later)).lines, [`schedule news: skipped, ${key} is not Done`]);
  assert.deepEqual([asks().length, schedules()[0].last, schedules()[0].skipped], [1, key, { at: later.toISOString(), key }]);

  // Hours asleep past several fires come back as one, related to the last task, which the pointer moves on from.
  const done = cards().map((c) => (c.key === key ? { ...c, lane: 'done' } : c));
  const woke = new Date(now.getTime() + 30 * 3600_000);
  const fired = await fireSchedules(audit(),done, woke);
  assert.equal(asks().length, 2);
  const next = items().find((it) => it.from_ask === asks()[1].id);
  assert.deepEqual([asks()[1].data.links, next.related], [{ related: [key] }, [key]]);
  assert.deepEqual(fired.lines, [`schedule news: filed audit/${next.id}`]);
  assert.deepEqual([schedules()[0].last, schedules()[0].skipped, schedules()[0].due_at], [`audit/${next.id}`, undefined, new Date(woke.getTime() + 4 * 3600_000).toISOString()]);
  assert.deepEqual((await fireSchedules(audit(),done, woke)).lines, []);

  // Its thread opens with who asked, linking the last fire's task.
  const events = lines(site('audit', 'data', 'events.jsonl'));
  const from = threadOf(`audit/${next.id}`, { events, fromAsk: next.from_ask }).find((m) => m.line === 'asked-from');
  assert.match(from.text, /From schedule news/);
  assert.equal(from.link, `#selectedCard=${encodeURIComponent(key)}`);
});
