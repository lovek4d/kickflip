import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from '../board/mini-dom.mjs';
import { DEFAULTS, windowAt, hold, flushAt, snoozeEnd } from './schedule.mjs';
import { hubView, settingsView, pollingView, pollLine, siteHealth, flushView } from './views.mjs';

const t = (h, m = 0, day = 14, s = 0) => new Date(2026, 9, day, h, m, s);
const ON = { on: true, weekends_off: false, snoozed_until: null };
const win = (...pairs) => ({ windows: pairs.map(([from, every_minutes]) => ({ from, every_minutes })), hold_overnight: true, wakes: ['08:00', '09:00'], notifications: ON });
const notify = (s, n) => ({ ...s, notifications: { ...ON, ...n } });
const status = (now, s, count = 0) => ({ settings: s, window: windowAt(now, s), hold: hold(now, s), count, nextFlushAt: count ? flushAt(now, s) : null });
const poll = (now, last = null) => ({ running: false, nextAt: new Date(now.getTime() + 30 * 60_000), last });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('pollLine says when the next check runs and what the last one found', () => {
  const now = t(19);
  assert.equal(pollLine(poll(now), now), 'Next check 7:30pm');
  assert.equal(pollLine({ ...poll(now), running: true }, now), 'Checking GitHub now');
  const last = (r) => pollLine(poll(now, { at: t(18, 45).toISOString(), failed: [], watched: 0, changes: [], ...r }), now);
  assert.equal(last({ watched: 2, changes: [{}] }), 'Next check 7:30pm · last 6:45pm, 2 PRs, 1 changed');
  assert.equal(last({ watched: 1 }), 'Next check 7:30pm · last 6:45pm, 1 PR, no change');
  assert.equal(last({}), 'Next check 7:30pm · last 6:45pm, no PRs watched');
  assert.equal(last({ watched: 3, failed: ['x'] }), 'Next check 7:30pm · last 6:45pm, could not reach GitHub for every PR');
});

test('Polling shows every window of the day, the one ?w= names or the one now falls in, and the hold and wakes', () => {
  const now = t(19);
  const v = pollingView({ now, st: status(now, DEFAULTS), poll: poll(now) });
  assert.equal(v.select, '18:00');
  assert.equal(pollingView({ now, st: status(now, DEFAULTS), poll: poll(now), select: '08:00' }).select, '08:00');
  assert.equal(pollingView({ now, st: status(now, DEFAULTS), poll: poll(now), select: '07:00' }).select, '18:00');
  assert.deepEqual(plain(v.now), { title: 'Checks every 30 min until 10:00pm', lines: ['Next check 7:30pm', 'No pushes queued.'], count: 0 });
  assert.deepEqual(plain(v.windows[1]), {
    from: '18:00', range: '6:00pm – 10:00pm', ends: '10:00pm', checks: '8 checks in this window', split: true, remove: true,
    every: [5, 10, 15, 30, 60, 120].map((m) => ({ minutes: m, label: m >= 60 ? `${m / 60} h` : `${m} min`, on: m === 30 })),
  });
  assert.deepEqual(v.windows.map((w) => [w.range, w.checks]), [['8:00am – 6:00pm', '40 checks in this window'], ['6:00pm – 10:00pm', '8 checks in this window'], ['10:00pm – 8:00am', '10 checks in this window']]);
  assert.deepEqual(v.day.segments.map((g) => [g.w, g.left, g.width, g.held, g.label]), [
    ['08:00', '33.333%', '41.667%', false, '15m'], ['18:00', '75.000%', '16.667%', false, '30m'], ['22:00', '91.667%', '8.333%', true, '1h'], ['22:00', '0.000%', '33.333%', true, '1h']]);
  assert.equal(v.day.segments[2].aria, '10:00pm – 8:00am, every 1 h, pushes held');
  assert.deepEqual(v.day.segments.map((g) => g.shade), ['76%', '61%', '45%', '45%']);
  assert.deepEqual(plain(v.day.pins), [{ left: '33.333%', title: 'Wake 8:00am' }, { left: '37.500%', title: 'Wake 9:00am' }]);
  assert.deepEqual([v.day.now, v.day.held, v.day.wakes], ['79.167%', true, true]);
  assert.deepEqual(plain(v.hold), { on: true, sub: 'Pushes queued after 10:00pm wait until 8:00am. GitHub checks still run.' });
  assert.deepEqual(plain(v.wakes), [{ value: '08:00', label: '8:00am' }, { value: '09:00', label: '9:00am' }]);

  const one = pollingView({ now, st: status(now, { ...win(['09:00', 20]), wakes: [] }, 2), poll: poll(now) });
  assert.deepEqual([one.windows[0].range, one.windows[0].ends, one.windows[0].remove, one.windows[0].every.map((c) => c.minutes)], ['All day', '—', false, [5, 10, 15, 20, 30, 60, 120]]);
  assert.deepEqual([one.hold.sub, one.day.held, one.day.wakes, one.wakes], ['With one window there is no overnight to hold.', false, false, []]);
  assert.equal(one.now.lines[1], '2 pushes queued; next send 7:20pm.');
});

test('Hub Settings says whether pushes go, when a snooze ends and what each snooze choice would end at', () => {
  const now = t(10);
  const v = settingsView({ now, st: status(now, DEFAULTS), rules: [{ id: 'r1', text: 'Be brief' }] });
  assert.equal(v.snoozed, null);
  assert.deepEqual(plain(v.on), { on: true, sub: 'On. Turn off to drop every push, urgent ones too.',
    confirm: 'Turn off notifications? Every push is dropped until you turn them back on, urgent ones too. Needs you and the badge still update.' });
  assert.deepEqual(plain(v.weekends), { on: false, sub: 'Pushes wait from Friday 10:00pm until Monday 8:00am. Urgent ones still go.' });
  assert.equal(v.polling, '3 windows, 58 checks a day · held overnight · wakes 8:00am, 9:00am');
  assert.equal(v.device, 'checks every 15 min until 6:00pm');
  assert.deepEqual(v.snooze.choices.map((c) => [c.value, c.label, c.until]), [['3h', '3h', 'until 1:00pm'], ['6h', '6h', 'until 4:00pm'],
    ['1d', '1d', 'until 10:00am tomorrow'], ['monday', 'Monday', 'until 8:00am Mon Oct 19']]);
  assert.deepEqual(plain(v.rules), [{ id: 'r1', text: 'Be brief' }]);
  assert.deepEqual(plain(v.presence), { title: 'Away from the Mac', sub: 'Pushes go to every device. At the Mac means unlocked and used in the last 3 minutes.' });
  assert.deepEqual(plain(settingsView({ now, st: status(now, DEFAULTS), route: { atMac: true, desktops: 1 } }).presence),
    { title: 'At the Mac', sub: 'Pushes go to the Mac only. Prompts, faults and urgent pushes still reach the phone.' });
  assert.deepEqual(plain(settingsView({ now, st: status(now, DEFAULTS), route: { atMac: true, desktops: 0 } }).presence),
    { title: 'At the Mac', sub: 'No notifications on the Mac, so pushes still go to the phone.' });

  const snoozed = settingsView({ now, st: status(now, notify(DEFAULTS, { snoozed_until: t(12).toISOString() }), 2) });
  assert.deepEqual(plain(snoozed.snoozed), { title: 'Snoozed until 12:00pm' });
  assert.equal(snoozed.snooze, null);
  assert.equal(snoozed.device, 'checks every 15 min until 6:00pm; snoozed until 12:00pm');
  assert.match(snoozed.on.confirm, / The 2 queued pushes are dropped now\. /);

  const evening = settingsView({ now: t(19), st: status(t(19), DEFAULTS) });
  assert.deepEqual(evening.snooze.choices.map((c) => c.value), ['3h', '6h', '1d', 'monday']);

  const off = settingsView({ now, st: status(now, notify(DEFAULTS, { on: false, snoozed_until: t(12).toISOString() })) });
  assert.deepEqual([off.snoozed, off.snooze, off.presence], [null, null, null]);
  assert.deepEqual([off.on.on, off.on.sub], [false, 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.']);
  assert.equal(off.device, 'checks every 15 min until 6:00pm; notifications are off');
});

test('Hub Settings shows the Codex setting, defaulting to Off, with the meaning of each choice', () => {
  const now = t(10);
  const view = (extra = {}) => settingsView({ now, st: status(now, DEFAULTS), ...extra });
  assert.equal(view().codexShare, 'off');
  assert.equal(view().codex.choices.find((c) => c.on).value, 'off');
  assert.equal(view().codex.description, 'No Codex.');
  const meanings = {
    always: 'Codex builds and reviews; while Codex is out of usage, that work pauses until a usage-reset check succeeds.',
    auto: 'Codex builds and reviews; while Codex is out of usage, Opus builders take over until it resets.',
    off: 'No Codex.',
  };
  for (const [codexShare, description] of Object.entries(meanings)) {
    const v = view({ codexShare });
    assert.equal(v.codexShare, codexShare);
    assert.deepEqual(v.codex.choices.map((c) => [c.value, c.label, c.on]), [
      ['always', 'Always on', codexShare === 'always'], ['auto', 'Auto', codexShare === 'auto'], ['off', 'Off', codexShare === 'off'],
    ]);
    assert.equal(v.codex.description, description);
    assert.equal(v.codex.note, "Applies to every board. A session's own /codex-share overrides it for that session.");
  }
});

test('Hub settings modals keep summaries, turn this device on, snooze inline and save each Codex choice or show a refusal', async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  document.body = root;
  const listeners = [];
  const posts = [];
  const now = t(10);
  const data = (codexShare, notifications = ON) => settingsView({ now, st: status(now, notify(DEFAULTS, notifications)), codexShare });
  let refused = false;
  let live;
  let subscribed = false;
  let requested = false;
  let sidebarChanges = 0;
  const subscription = { toJSON: () => ({ endpoint: 'https://push.example/device' }) };
  const registration = { pushManager: {
    getSubscription: async () => subscribed ? subscription : null,
    subscribe: async () => { subscribed = true; return subscription; },
  } };
  const context = vm.createContext({
    URL, URLSearchParams, document,
    Date: class extends Date { static now() { return now.getTime(); } },
    location: new URL('https://mac.ts.net/_hub/'), history: { replaceState() {} },
    BoardDialogs: { fitSheet: () => () => {}, confirm: async () => false },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { userAgent: 'Mac', serviceWorker: { getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration) } },
    PushManager: class {},
    Notification: { permission: 'default', requestPermission: () => { requested = true; return Promise.resolve('granted'); } },
    FormData: class {
      constructor(form) { this.form = form; }
      *[Symbol.iterator]() { for (const el of this.form.querySelectorAll('input[name]')) yield [el.getAttribute('name'), el.value]; }
    },
    BoardView: { page: (root, site, run) => { const B = { root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }; run(B); return B; } },
    RulesEditor: { mount: () => ({ set() {} }) },
    fetch: async (url, opts) => {
      posts.push({ url, opts });
      if (url === '/_hub/push/key') return { json: async () => ({ key: 'AQID' }) };
      if (url === '/_hub/push/subscribe') return { json: async () => ({ ok: true }) };
      if (url === '/_hub/settings/notifications') {
        const choice = opts.body.get('snooze');
        const end = choice === 'off' ? null : snoozeEnd(now, choice, DEFAULTS);
        return { ok: true, json: async () => data('off', { ...ON, snoozed_until: end?.toISOString() || null }) };
      }
      return { ok: !refused, json: async () => refused ? { error: 'Could not save Codex setting.' } : data(opts.body.get('value')) };
    },
  });
  for (const file of ['ui-hub.js', 'ui-page-header.js', 'hub-kit.js', 'router.js', 'view-hub-settings.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  }
  context.HubKit.live = (B, options) => { live = options; };
  const view = context.HubSettings;
  root.innerHTML = view.markup();
  context.window = context;
  assert.equal(root.querySelectorAll('details').length, 0);
  const B = view.create(root, '/_hub', { view: { hash: '#rules' }, sidebarChanged: () => sidebarChanges++ });
  live.paint(data());
  await new Promise((r) => setImmediate(r));
  const modal = root.querySelector('#hubSettingsModal');
  assert.equal(modal.open, true);
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Rules for every board');
  assert.equal(root.querySelectorAll('[data-summary]').length, 5);
  assert.equal(root.querySelector('[data-summary=codex]').textContent, 'Off');
  const rulesBox = root.querySelector('#hubRules');
  rulesBox.setAttribute('data-dirty', '');
  live.paint(data());
  assert.equal(root.querySelector('#hubRules'), rulesBox);
  assert.equal(await B.openSettings({ hash: '#notifications' }), false);
  rulesBox.removeAttribute('data-dirty');
  await B.openSettings({ hash: '#notifications' });
  assert.deepEqual(root.querySelectorAll('.hub-setting .title').map((h) => h.textContent), ['Notifications', 'Polling', 'Codex share', 'Rules for every board', 'Closed boards']);
  assert.deepEqual(root.querySelectorAll('form input[name="set"]').map((input) => input.value), ['on', 'weekends']);
  assert.deepEqual(root.querySelectorAll('.snooze-choices button').map((b) => b.textContent), ['3h', '6h', '1d', 'Monday']);
  assert.equal(root.querySelector('.snooze-custom .btn').textContent, 'Custom');
  assert.equal(root.querySelectorAll('dialog').length, 1);
  assert.equal(modal.open, true);
  assert.match(root.textContent, /Away from the Mac/);
  assert.doesNotMatch(modal.textContent, /Pushes wait, then go|Turn off to drop|unlocked and used/);
  const enable = root.querySelector('[data-device="on"]');
  assert.equal(enable.textContent, 'Turn on');
  for (const l of listeners.filter((l) => l.target === root && l.type === 'click')) l.fn({ target: enable });
  assert.equal(requested, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(subscribed, true);
  assert.equal(sidebarChanges, 1);
  assert.equal(root.querySelector('[data-device="test"]').textContent, 'Test');
  assert.equal(root.querySelector('#push .val').textContent, 'On');
  assert.ok(posts.some(({ url, opts }) => url === '/_hub/push/subscribe' && JSON.parse(opts.body).endpoint === 'https://push.example/device'));
  const submitForm = (form, button) => listeners.find((l) => l.target === root && l.type === 'submit').fn({ target: form,
    submitter: button && { name: button.getAttribute('name'), value: button.value }, preventDefault() {} });
  const endSnooze = async () => {
    assert.equal(root.querySelector('.snooze-chips'), null);
    const form = root.querySelector('.snooze-on form');
    assert.equal(form.querySelector('button').textContent, 'End');
    await submitForm(form, form.querySelector('button'));
    assert.ok(root.querySelector('.snooze-chips'));
  };
  for (const choice of ['3h', '6h', '1d', 'monday']) {
    const form = root.querySelector('.snooze-choices');
    await submitForm(form, form.querySelector(`button[value="${choice}"]`));
    assert.equal(posts.at(-1).opts.body.toString(), `snooze=${choice}`);
    assert.match(root.querySelector('.snooze-on .title').textContent, /^Snoozed until /);
    assert.match(root.querySelector('[data-summary=notifications]').textContent, /Snoozed until/);
    assert.equal(modal.open, true);
    await endSnooze();
  }
  const input = root.querySelector('[data-snooze-at]');
  assert.equal(input.value, '2026-10-14T11:00');
  assert.equal(input.min, '2026-10-14T10:01');
  assert.equal(new Date(input.max) - now, 30 * 86_400_000);
  input.form = root.querySelector('.snooze-custom');
  input.checkValidity = () => true;
  let saving;
  input.form.requestSubmit = () => { saving = submitForm(input.form); };
  input.value = '2026-10-15T15:30';
  input.focus();
  const beforeCustom = posts.length;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'change')) await l.fn({ target: input });
  assert.equal(posts.length, beforeCustom, 'spinning the wheel does not submit or tear down the picker');
  assert.equal(root.querySelector('[data-snooze-at]'), input);
  document.activeElement = null;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'focusout')) l.fn({ target: input });
  await saving;
  assert.equal(posts.at(-1).opts.body.get('snooze'), t(15, 30, 15).toISOString());
  assert.equal(root.querySelector('.snooze-on .title').textContent, 'Snoozed until 3:30pm tomorrow');
  await endSnooze();
  await B.openSettings({ hash: '#codex' });
  const selected = () => root.querySelector('.segments button[aria-pressed="true"]').value;
  const submit = (value) => {
    const form = root.querySelector('.segments');
    const button = form.querySelector(`button[value="${value}"]`);
    return listeners.find((l) => l.target === root && l.type === 'submit').fn({ target: form,
      submitter: { name: button.getAttribute('name'), value: button.value }, preventDefault() {} });
  };
  assert.equal(selected(), 'off');
  assert.equal(root.querySelector('#codexDescription'), null);
  assert.deepEqual(root.querySelectorAll('.segments button').map((b) => b.textContent), ['Always on', 'Auto', 'Off']);
  assert.equal(root.querySelector('.segments').getAttribute('aria-label'), 'Codex share');
  assert.equal(root.querySelector('#codexNote'), null);
  for (const value of ['always', 'off', 'auto']) {
    await submit(value);
    assert.equal(selected(), value);
    assert.equal(modal.open, true);
    assert.equal(root.querySelector('[data-summary=codex]').textContent, data(value).codex.choices.find((c) => c.on).label);
    const { url, opts } = posts.at(-1);
    assert.equal(url, '/_hub/settings/codex');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.accept, 'application/json');
    assert.equal(opts.body.toString(), `value=${value}`);
  }
  refused = true;
  await submit('off');
  assert.equal(selected(), 'auto');
  assert.equal(root.querySelector('[role="alert"]').textContent, 'Could not save Codex setting.');
});

test("the hub page lists Boards and Pages apart with each site's health and links, and says what the hub runs, polls and holds", () => {
  const now = t(19);
  const ok = (link) => ({ link, ok: true, state: 'ok', detail: '' });
  const rows = [
    { route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'beta', title: 'Beta', state: 'up' },
    { route: 'gone', title: 'Gone', state: 'down' }, { route: 'learn', title: 'Learn', state: 'up' }, { route: 'new', title: 'New', state: 'starting' },
  ];
  const links = {
    alpha: [ok('github'), ok('events'), ok('pushes')],
    beta: [ok('github'), { link: 'events', ok: false, state: 'broken', detail: 'no watcher since 6:00pm' }, { link: 'wakes', ok: false, state: 'settling', detail: 'missed 9:00am' }],
  };
  const sidebar = {
    total: 3, sites: rows.map((r) => ({ route: r.route, board: ['alpha', 'beta', 'gone', 'new'].includes(r.route) })),
    hub: { tone: 'down', word: '2 broken', detail: '3 of 5 sites up' }, notifications: { state: 'on', text: 'On' },
  };
  const v = hubView({ now, st: status(now, DEFAULTS, 1), poll: poll(now), sidebar, rows, links: new Map(Object.entries(links)), code: { running: 'abc', onDisk: 'abc' }, host: 'mac.ts.net', rules: [{ text: 'a' }, { text: 'b' }] });
  assert.deepEqual(v.groups.map((g) => [g.label, g.sites.map((s) => [s.route, s.tone, s.word, s.href])]), [
    ['Boards', [['alpha', 'ok', 'Up · listening · every link passes', '/alpha/'], ['beta', 'down', '1 link broken · not listening', '/beta/'],
      ['gone', 'down', 'Down · restarting', '/gone/'], ['new', 'wait', 'Starting', '/new/']]],
    ['Pages', [['learn', 'ok', 'Up', '/learn/']]],
  ]);
  assert.deepEqual(plain(v.groups[0].sites[1].lines), [{ link: 'events', detail: 'no watcher since 6:00pm' }, { link: 'wakes', detail: 'settling: missed 9:00am' }]);
  assert.match(v.groups[0].sites[0].icon, /^<span class="icon/);
  assert.deepEqual(plain(v.hub), { tone: 'down', word: '2 broken', detail: '3 of 5 sites up · runs the code in its files (abc)' });
  const staleHub = { tone: 'wait', word: 'Needs a restart', detail: '3 of 5 sites up · runs older code than its files; restart it' };
  assert.deepEqual(plain(hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar: { ...sidebar, hub: staleHub }, rows, code: { running: 'old', onDisk: 'abc' } }).hub), staleHub);
  assert.deepEqual(plain(v.polling), { title: 'Checks every 30 min until 10:00pm', lines: ['Next check 7:30pm', '1 push queued; next send 7:30pm.'], count: 1,
    summary: '3 windows, 58 checks a day · held overnight · wakes 8:00am, 9:00am' });
  assert.deepEqual(plain(v.notifications), { on: true, text: 'On', device: 'checks every 30 min until 10:00pm' });
  assert.deepEqual([v.rules, v.sites, v.host, v.total, v.empty], ['2 rules', '5 sites', 'mac.ts.net', 3, false]);
  const none = hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar: { ...sidebar, sites: [] }, rows: [] });
  assert.deepEqual([none.groups, none.empty, none.rules, none.sites], [[], true, 'None yet', '0 sites']);
  assert.deepEqual(plain(siteHealth({ state: 'stopped' })), { tone: 'wait', word: 'Stopped', lines: [] });
  assert.deepEqual(plain(siteHealth({ state: 'up' }, [ok('github'), { ...ok('events'), listen: 'asleep' }])), { tone: 'ok', word: 'Up · asleep · every link passes', lines: [] });
});

test('Send now says how many queued pushes went, or that none could', () => {
  assert.deepEqual(flushView(null), { sent: 0, count: 0, ok: true, message: 'Nothing was queued.' });
  assert.deepEqual(flushView({ count: 2, sent: 2, ok: true }), { sent: 2, count: 2, ok: true, message: 'Sent 2 queued pushes.' });
  assert.deepEqual(flushView({ count: 1, sent: 1, ok: true }).message, 'Sent 1 queued push.');
  assert.deepEqual(flushView({ count: 2, sent: 0, ok: false }), { sent: 0, count: 2, ok: false, message: 'Could not send the queue. It stays queued for the next check.' });
});

test('the hub page shows each session\'s remembered rules under its board, escaped and read-only', () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  let live;
  const context = vm.createContext({
    navigator: {},
    BoardView: { page: (root, site, run) => run({ $: (s) => root.querySelector(s), atUnmount() {}, on() {} }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { header: () => '' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { device: () => ({ state: () => null }), forms: () => ({}), live: (B, opts) => { live = opts; } },
  });
  for (const file of ['ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const sessions = [{ session: 's-alpha', rules: ['Bash(echo "<img>")', 'Write(//r/a)', 'WebFetch(domain:docs.x.dev)'] }];
  const data = hubView({ now, st: status(now, DEFAULTS), poll: poll(now),
    sidebar: { sites: [{ route: 'alpha', board: true }, { route: 'beta', board: true }], hub: {}, notifications: {}, total: 0 },
    rows: [{ route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'beta', title: 'Beta', state: 'up' }], remembered: new Map([['alpha', sessions]]),
  });
  assert.deepEqual(data.groups[0].sites.map((s) => s.remembered), [sessions, []]);
  live.paint({ ...data, remembered: [{ session: 's-alone', rules: ['WebSearch'] }] });
  const lists = root.querySelectorAll('.remembered');
  assert.equal(lists.length, 2);
  assert.match(lists[0].textContent, /Always allow · session s-alpha/);
  assert.deepEqual(lists[0].querySelectorAll('li code').map((el) => el.textContent), sessions[0].rules);
  assert.equal(lists[0].previousSibling.getAttribute('href'), '/alpha/');
  assert.equal(lists[0].querySelectorAll('a, button, input').length, 0);
  assert.equal(lists[0].querySelector('img'), null);
  assert.match(lists[1].textContent, /s-alone.*WebSearch/);
  live.paint({ ...data, groups: data.groups.map((g) => ({ ...g, sites: g.sites.map((s) => ({ ...s, remembered: [] })) })) });
  assert.equal(root.querySelector('.remembered'), null);
});
