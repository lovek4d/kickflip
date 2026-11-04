import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from '../board/mini-dom.mjs';
import { DEFAULTS, windowAt, hold, flushAt, snoozeEnd } from './schedule.mjs';
import { durationEnd } from './duration.mjs';
import { hubView, settingsView, pollingView, pollLine, siteHealth, flushView } from './views.mjs';
import { codexStatus } from '../shared/codex.mjs';

const t = (h, m = 0, day = 14, s = 0) => new Date(2026, 9, day, h, m, s);
const ON = { on: true, weekends_off: false, snoozed_until: null };
const win = (...pairs) => ({ windows: pairs.map(([from, every_minutes]) => ({ from, every_minutes })), hold_overnight: true, wakes: ['08:00', '09:00'], notifications: ON });
const notify = (s, n) => ({ ...s, notifications: { ...ON, ...n } });
const status = (now, s, count = 0) => ({ settings: s, window: windowAt(now, s), hold: hold(now, s), count, nextFlushAt: count ? flushAt(now, s) : null });
const poll = (now, last = null) => ({ running: false, nextAt: new Date(now.getTime() + 30 * 60_000), last });
const plain = (v) => JSON.parse(JSON.stringify(v));
const USABLE = { usable: true, reason: null, words: null, fix: null };
const NOT_INSTALLED = codexStatus({ installed: false });
const LOGGED_OUT = codexStatus({ installed: true, home: '/nonexistent' });

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
  assert.deepEqual(v.snooze.choices.map((c) => [c.value, c.label, c.until]), [['1h', '1h', 'until 11:00am'], ['3h', '3h', 'until 1:00pm'], ['6h', '6h', 'until 4:00pm'],
    ['1d', '1d', 'until 10:00am tomorrow'], ['forever', 'Forever', 'until you end it']]);
  assert.deepEqual(plain(v.awake), { unsupported: null, on: null, summary: 'Off', choices: [['1h', 'until 11:00am'], ['3h', 'until 1:00pm'], ['6h', 'until 4:00pm'],
    ['1d', 'until 10:00am tomorrow'], ['forever', 'until you turn it off']].map(([value, until]) => ({ value, label: v.snooze.choices.find((c) => c.value === value).label, until })) });
  const awake = (until, unsupported = null) => plain(settingsView({ now, st: status(now, DEFAULTS), awake: { until, unsupported } }).awake);
  assert.deepEqual(awake(t(15)), { unsupported: null, on: { title: 'Keeping awake until 3:00pm' }, choices: null, summary: 'On until 3:00pm' });
  assert.deepEqual(awake('forever'), { unsupported: null, on: { title: 'Keeping awake until you turn it off' }, choices: null, summary: 'On · forever' });
  assert.deepEqual(awake(null, 'macOS only · this host runs Linux'), { unsupported: 'macOS only · this host runs Linux', on: null, choices: null, summary: 'macOS only · this host runs Linux' });
  assert.deepEqual(plain(v.rules), [{ id: 'r1', text: 'Be brief' }]);
  assert.deepEqual(plain(v.presence), { title: 'Away from the host', sub: 'Pushes go to every device. At the host means unlocked and used in the last 3 minutes.' });
  assert.deepEqual(plain(settingsView({ now, st: status(now, DEFAULTS), route: { atMac: true, desktops: 1 } }).presence),
    { title: 'At the host', sub: 'Pushes go to the host only. Prompts, faults and urgent pushes still reach the phone.' });
  assert.deepEqual(plain(settingsView({ now, st: status(now, DEFAULTS), route: { atMac: true, desktops: 0 } }).presence),
    { title: 'At the host', sub: 'No notifications on the host, so pushes still go to the phone.' });

  const snoozed = settingsView({ now, st: status(now, notify(DEFAULTS, { snoozed_until: t(12).toISOString() }), 2) });
  assert.deepEqual(plain(snoozed.snoozed), { title: 'Snoozed until 12:00pm', summary: 'Snoozed until 12:00pm' });
  assert.equal(snoozed.snooze, null);
  assert.equal(snoozed.device, 'checks every 15 min until 6:00pm; snoozed until 12:00pm');
  assert.match(snoozed.on.confirm, / The 2 queued pushes are dropped now\. /);

  const forever = settingsView({ now, st: status(now, notify(DEFAULTS, { snoozed_until: 'forever' }), 2) });
  assert.deepEqual(plain(forever.snoozed), { title: 'Snoozed until you end it', summary: 'Snoozed · forever' });
  assert.equal(forever.snooze, null);
  assert.equal(forever.device, 'checks every 15 min until 6:00pm; snoozed until you end it');

  const off = settingsView({ now, st: status(now, notify(DEFAULTS, { on: false, snoozed_until: t(12).toISOString() })) });
  assert.deepEqual([off.snoozed, off.snooze, off.presence], [null, null, null]);
  assert.deepEqual([off.on.on, off.on.sub], [false, 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.']);
  assert.equal(off.device, 'checks every 15 min until 6:00pm; notifications are off');
});

test("the hub page's Codex share says what each choice means while Codex is usable, why not and what to run while it isn't, and Hub Settings no longer carries it", () => {
  const now = t(10);
  const sidebar = { sites: [], hub: {}, notifications: {}, total: 0, usage: { claude: null, codex: null } };
  const view = (extra = {}) => hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar, rows: [], ...extra }).codex;
  const unusable = (v) => [v.usable, v.tag, v.share, v.choices.find((c) => c.on).value, v.description, v.fix];
  assert.deepEqual(unusable(view()), [false, 'not installed', 'off', 'off', "Codex isn't installed on the host.", process.platform === 'darwin' ? 'brew install --cask codex' : 'npm i -g @openai/codex']);
  assert.deepEqual(unusable(view({ codex: NOT_INSTALLED })), unusable(view()));
  assert.deepEqual(unusable(view({ codex: LOGGED_OUT })), [false, 'not logged in', 'off', 'off', "Codex isn't logged in on the host.", 'codex login']);
  const meanings = {
    always: 'Codex implements and reviews. Work pauses when it runs out.',
    auto: "Codex implements and reviews, and Claude takes over while it's out.",
    off: 'Claude implements and reviews.',
  };
  // The Claude model names who takes over: the forced model, or Claude under Auto.
  for (const [claudeModel, word] of [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['auto', 'Claude']]) {
    assert.equal(view({ codexShare: 'auto', codex: USABLE, claudeModel }).description, `Codex implements and reviews, and ${word} takes over while it's out.`);
    assert.equal(view({ codexShare: 'off', codex: USABLE, claudeModel }).description, `${word} implements and reviews.`);
  }
  for (const [codexShare, description] of Object.entries(meanings)) {
    const v = view({ codexShare, codex: USABLE });
    assert.deepEqual([v.usable, v.tag, v.share, v.fix], [true, null, codexShare, null]);
    assert.deepEqual(v.choices.map((c) => [c.value, c.label, c.on]), [
      ['always', 'Always on', codexShare === 'always'], ['auto', 'Auto', codexShare === 'auto'], ['off', 'Off', codexShare === 'off'],
    ]);
    assert.equal(v.description, description);
  }
  const settings = settingsView({ now, st: status(now, DEFAULTS) });
  assert.deepEqual([settings.codex, settings.codexShare], [undefined, undefined]);
});

test('Hub settings modals keep summaries, turn this device on, snooze and keep awake inline through one duration picker, with no Codex share row or modal', async () => {
  const document = {};
  const listeners = [];
  const { Element } = miniDom(class {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
    removeEventListener(type, fn) { listeners.splice(listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn), 1); }
  }, document);
  const root = new Element('div');
  document.body = root;
  const posts = [];
  const now = t(10);
  let linear = { set: false };
  let checked = null;
  let awake = { until: null, unsupported: null };
  const data = (notifications = ON) => settingsView({ now, st: status(now, notify(DEFAULTS, notifications)), linear, awake });
  let confirmed = false;
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
    BoardDialogs: { fitSheet: () => () => {}, confirm: async () => confirmed },
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
      if (url === '/_hub/settings/linear') {
        await checked?.promise;
        linear = opts.body.has('remove') ? { set: false } : opts.body.get('key') === 'bad' ? { set: true, refused: true } : { set: true, workspace: 'Acme', url_key: 'acme' };
        return { ok: true, json: async () => data() };
      }
      if (url === '/_hub/settings/notifications') {
        const choice = opts.body.get('snooze');
        const end = choice === 'off' ? null : snoozeEnd(now, choice, DEFAULTS);
        return { ok: true, json: async () => data({ ...ON, snoozed_until: end === 'forever' ? end : end?.toISOString() || null }) };
      }
      if (url === '/_hub/settings/keep-awake') {
        const choice = opts.body.get('keep_awake');
        awake = { ...awake, until: choice === 'off' ? null : durationEnd(now, choice) };
        return { ok: true, json: async () => data() };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  for (const file of ['ui-hub.js', 'ui-page-header.js', 'hub-kit.js', 'linear-key.js', 'router.js', 'view-hub-settings.js']) {
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
  assert.equal(root.querySelectorAll('[data-summary]').length, 6);
  const rulesBox = root.querySelector('#hubRules');
  rulesBox.setAttribute('data-dirty', '');
  live.paint(data());
  assert.equal(root.querySelector('#hubRules'), rulesBox);
  assert.equal(await B.openSettings({ hash: '#notifications' }), false);
  rulesBox.removeAttribute('data-dirty');
  await B.openSettings({ hash: '#notifications' });
  assert.deepEqual(root.querySelectorAll('.hub-setting .title').map((h) => h.textContent), ['Notifications', 'Polling', 'Keep awake', 'Linear', 'Rules for every board', 'Closed boards']);
  assert.deepEqual(root.querySelectorAll('form input[name="set"]').map((input) => input.value), ['on', 'weekends']);
  assert.deepEqual(root.querySelectorAll('.dur-choices button').map((b) => b.textContent), ['1h', '3h', '6h', '1d', 'Forever']);
  assert.equal(root.querySelector('.dur-custom .btn').textContent, 'Custom');
  assert.equal(root.querySelectorAll('dialog').length, 1);
  assert.equal(modal.open, true);
  assert.match(root.textContent, /Away from the host/);
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
    assert.equal(root.querySelector('.dur-chips'), null);
    const form = root.querySelector('.dur-on form');
    assert.equal(form.querySelector('button').textContent, 'End');
    await submitForm(form, form.querySelector('button'));
    assert.ok(root.querySelector('.dur-chips'));
  };
  for (const choice of ['1h', '3h', '6h', '1d', 'forever']) {
    const form = root.querySelector('.dur-choices');
    await submitForm(form, form.querySelector(`button[value="${choice}"]`));
    assert.equal(posts.at(-1).opts.body.toString(), `snooze=${choice}`);
    assert.match(root.querySelector('.dur-on .title').textContent, /^Snoozed until /);
    assert.match(root.querySelector('[data-summary=notifications]').textContent, /Snoozed (until|· forever)/);
    assert.equal(modal.open, true);
    await endSnooze();
  }
  const input = root.querySelector('[data-dur-at]');
  assert.equal(input.value, '2026-10-14T11:00');
  assert.equal(input.min, '2026-10-14T10:01');
  assert.equal(new Date(input.max) - now, 30 * 86_400_000);
  input.form = root.querySelector('.dur-custom');
  input.checkValidity = () => true;
  let saving;
  input.form.requestSubmit = () => { saving = submitForm(input.form); };
  input.value = '2026-10-15T15:30';
  input.focus();
  const beforeCustom = posts.length;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'change')) await l.fn({ target: input });
  assert.equal(posts.length, beforeCustom, 'spinning the wheel does not submit or tear down the picker');
  assert.equal(root.querySelector('[data-dur-at]'), input);
  document.activeElement = null;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'focusout')) l.fn({ target: input });
  await saving;
  assert.equal(posts.at(-1).opts.body.get('snooze'), t(15, 30, 15).toISOString());
  assert.equal(root.querySelector('.dur-on .title').textContent, 'Snoozed until 3:30pm tomorrow');
  await endSnooze();
  const suggestedInput = root.querySelector('[data-dur-at]');
  const suggested = suggestedInput.value;
  suggestedInput.form = root.querySelector('.dur-custom');
  suggestedInput.checkValidity = () => true;
  suggestedInput.form.requestSubmit = () => { saving = submitForm(suggestedInput.form); };
  const beforeSuggested = posts.length;
  suggestedInput.focus();
  document.activeElement = null;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'focusout')) l.fn({ target: suggestedInput });
  assert.equal(posts.length, beforeSuggested, 'tabbing through the suggested time does not snooze');
  for (const l of listeners.filter((l) => l.target === root && l.type === 'click')) l.fn({ target: suggestedInput });
  document.activeElement = null;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'focusout')) l.fn({ target: suggestedInput });
  for (const l of listeners.filter((l) => l.target === root && l.type === 'change')) l.fn({ target: suggestedInput });
  await saving;
  assert.equal(posts.length, beforeSuggested + 1);
  assert.equal(posts.at(-1).opts.body.get('snooze'), new Date(suggested).toISOString());
  assert.match(root.querySelector('.dur-on .title').textContent, /^Snoozed until /);
  await endSnooze();
  const chipInput = root.querySelector('[data-dur-at]');
  chipInput.form = root.querySelector('.dur-custom');
  chipInput.checkValidity = () => true;
  saving = null;
  chipInput.form.requestSubmit = () => { saving = submitForm(chipInput.form); };
  const chipForm = root.querySelector('.dur-choices');
  const chip = chipForm.querySelector('button[value="3h"]');
  const beforeChip = posts.length;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'click')) l.fn({ target: chipInput });
  for (const l of listeners.filter((l) => l.target === root && l.type === 'pointerdown')) l.fn({ target: chip });
  document.activeElement = null;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'focusout')) l.fn({ target: chipInput });
  await Promise.all([saving, submitForm(chipForm, chip)]);
  assert.equal(posts.length, beforeChip + 1);
  assert.equal(posts.at(-1).opts.body.toString(), 'snooze=3h');
  await endSnooze();
  assert.equal(root.querySelector('[data-summary="keep-awake"]').textContent, 'Off');
  await B.openSettings({ hash: '#keep-awake' });
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Keep awake');
  assert.match(root.querySelector('.setting-content').textContent, /caffeinate -ims/);
  assert.deepEqual(root.querySelectorAll('.dur-choices button').map((b) => [b.textContent, b.getAttribute('name'), b.getAttribute('aria-label')]),
    [['1h', 'keep_awake', '1h, until 11:00am'], ['3h', 'keep_awake', '3h, until 1:00pm'], ['6h', 'keep_awake', '6h, until 4:00pm'],
      ['1d', 'keep_awake', '1d, until 10:00am tomorrow'], ['Forever', 'keep_awake', 'Forever, until you turn it off']]);
  const turnOff = async () => {
    const form = root.querySelector('.dur-on form');
    assert.equal(form.querySelector('button').textContent, 'Turn off');
    await submitForm(form, form.querySelector('button'));
    assert.equal(posts.at(-1).opts.body.toString(), 'keep_awake=off');
    assert.equal(root.querySelector('[data-summary="keep-awake"]').textContent, 'Off');
  };
  const awakeChips = root.querySelector('.dur-choices');
  await submitForm(awakeChips, awakeChips.querySelector('button[value="forever"]'));
  assert.equal(posts.at(-1).url, '/_hub/settings/keep-awake');
  assert.equal(root.querySelector('.dur-on .title').textContent, 'Keeping awake until you turn it off');
  assert.equal(root.querySelector('[data-summary="keep-awake"]').textContent, 'On · forever');
  await turnOff();
  const awakeInput = root.querySelector('[data-dur-at]');
  assert.equal(awakeInput.getAttribute('aria-label'), 'Custom keep awake until a date and time');
  awakeInput.form = root.querySelector('.dur-custom');
  awakeInput.checkValidity = () => true;
  awakeInput.form.requestSubmit = () => { saving = submitForm(awakeInput.form); };
  awakeInput.value = '2026-10-14T13:30';
  document.activeElement = null;
  for (const l of listeners.filter((l) => l.target === root && l.type === 'change')) l.fn({ target: awakeInput });
  await saving;
  assert.equal(posts.at(-1).opts.body.get('keep_awake'), t(13, 30).toISOString());
  assert.equal(root.querySelector('.dur-on .title').textContent, 'Keeping awake until 1:30pm');
  assert.equal(root.querySelector('[data-summary="keep-awake"]').textContent, 'On until 1:30pm');
  await turnOff();
  awake = { until: null, unsupported: 'macOS only · this host runs Linux' };
  live.paint(data());
  assert.equal(root.querySelector('#keep-awake').disabled, true);
  assert.equal(root.querySelector('[data-summary="keep-awake"]').textContent, 'macOS only · this host runs Linux');
  assert.equal(root.querySelector('.dur-chips'), null);
  await B.openSettings({ hash: '#codex' });
  assert.equal(modal.open, false);
  assert.equal(root.querySelector('.segments'), null);
  await B.openSettings({ hash: '#linear' });
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Linear');
  assert.equal(root.querySelector('[data-summary=linear]').textContent, 'No key');
  assert.equal(root.querySelector('[data-linear-remove]'), null);
  assert.equal(root.querySelector('.lk-form button'), null);
  const content = root.querySelector('.setting-content');
  const fire = (target, type, extra = {}) => Promise.all(listeners.filter((l) => l.target === target && l.type === type).map((l) => l.fn({ target, preventDefault() {}, ...extra })));
  const settle = () => new Promise((r) => setImmediate(r));
  const keyLink = () => content.querySelector('a[href="https://linear.app/settings/account/security"]');
  assert.equal(keyLink().textContent, 'Linear › Settings › Security & access › Personal API keys');
  assert.match(content.textContent, /A board can pick Linear for its tickets only while this key works\./);
  checked = Promise.withResolvers();
  await fire(content, 'paste', { target: root.querySelector('#linearKey'), clipboardData: { getData: () => ' bad ' } });
  assert.equal(posts.at(-1).opts.body.toString(), 'key=bad');
  assert.match(content.textContent, /Checking the key with Linear…/);
  assert.equal(root.querySelector('#linearKey').disabled, true);
  const done = root.querySelector('.settings-footer [data-settings-dismiss]');
  assert.equal(done.getAttribute('aria-busy'), 'true');
  fire(root, 'click', { target: done });
  await settle();
  assert.equal(modal.open, true);
  checked.resolve();
  checked = null;
  await settle(); await settle();
  assert.equal(modal.open, false);
  assert.equal(done.getAttribute('aria-busy'), null);
  assert.equal(root.querySelector('[data-summary=linear]').textContent, 'Key doesn’t work');
  await B.openSettings({ hash: '#linear' });
  const slot = root.querySelector('.setting-content');
  assert.match(slot.textContent, /doesn’t work · Linear refused the key/);
  assert.ok(slot.querySelector('a[href="https://linear.app/settings/account/security"]'));
  assert.ok(slot.querySelector('[data-linear-remove]'));
  const keyInput = root.querySelector('#linearKey');
  keyInput.value = '';
  await fire(slot, 'submit', { target: root.querySelector('.lk-form') });
  assert.equal(posts.at(-1).opts.body.toString(), 'key=bad');
  keyInput.value = 'lin_api_secret123';
  await fire(slot, 'change', { target: keyInput });
  await settle();
  assert.equal(posts.at(-1).opts.body.toString(), 'key=lin_api_secret123');
  assert.equal(root.querySelector('[data-summary=linear]').textContent, 'Key set · Acme workspace');
  assert.match(slot.textContent, /Acme workspace/);
  assert.equal(slot.querySelector('a[href="https://linear.app/settings/account/security"]'), null);
  assert.doesNotMatch(root.innerHTML, /secret123/);
  confirmed = false;
  await fire(slot, 'click', { target: slot.querySelector('[data-linear-remove]') });
  assert.equal(posts.at(-1).opts.body.toString(), 'key=lin_api_secret123');
  confirmed = true;
  await fire(slot, 'click', { target: slot.querySelector('[data-linear-remove]') });
  await settle();
  assert.equal(posts.at(-1).opts.body.toString(), 'remove=1');
  assert.equal(root.querySelector('[data-summary=linear]').textContent, 'No key');
});

test("the hub page lists Boards and Pages apart with each site's health and links, and says what the hub runs, polls and holds", () => {
  const now = t(19);
  const ok = (link) => ({ link, ok: true, state: 'ok', detail: '' });
  const rows = [
    { route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'beta', title: 'Beta', state: 'up' },
    { route: 'gone', title: 'Gone', state: 'down' }, { route: 'learn', title: 'Learn', state: 'up' }, { route: 'new', title: 'New', state: 'starting' },
  ];
  const links = {
    alpha: [ok('github'), ok('events'), ok('wakes')],
    beta: [ok('github'), { link: 'events', ok: false, state: 'broken', detail: 'no watcher since 6:00pm' }, { link: 'wakes', ok: false, state: 'settling', detail: 'missed 9:00am' }],
  };
  const sidebar = {
    total: 3, sites: rows.map((r) => ({ route: r.route, board: ['alpha', 'beta', 'gone', 'new'].includes(r.route) })),
    hub: { tone: 'down', word: '1 site down', detail: '3 of 5 sites up · 1 link failing' }, notifications: { state: 'on', text: 'On' },
  };
  const v = hubView({ now, st: status(now, DEFAULTS, 1), poll: poll(now), sidebar, rows, links: new Map(Object.entries(links)), code: { running: 'abc', onDisk: 'abc' }, host: 'mac.ts.net', rules: [{ text: 'a' }, { text: 'b' }] });
  assert.deepEqual(v.groups.map((g) => [g.label, g.sites.map((s) => [s.route, s.tone, s.word, s.href])]), [
    ['Boards', [['alpha', 'ok', 'up · listening · every link passes', '/alpha/'], ['beta', 'wait', 'degraded · not listening', '/beta/'],
      ['gone', 'down', 'down · restarting', '/gone/'], ['new', 'wait', 'starting', '/new/']]],
    ['Pages', [['learn', 'ok', 'up', '/learn/']]],
  ]);
  assert.deepEqual(plain(v.groups[0].sites[1].lines), [{ link: 'events', detail: 'no watcher since 6:00pm' }, { link: 'wakes', detail: 'settling: missed 9:00am' }]);
  assert.match(v.groups[0].sites[0].icon, /^<span class="icon/);
  assert.deepEqual(plain(v.hub), { tone: 'down', word: '1 site down', detail: '3 of 5 sites up · 1 link failing · runs the code in its files (abc)', restart: false });
  const staleHub = { tone: 'wait', word: 'degraded', detail: '3 of 5 sites up · runs older code than its files; restart it' };
  assert.deepEqual(plain(hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar: { ...sidebar, hub: staleHub }, rows, code: { running: 'old', onDisk: 'abc' } }).hub), { ...staleHub, restart: true });
  assert.deepEqual(plain(v.polling), { title: 'Checks every 30 min until 10:00pm', lines: ['Next check 7:30pm', '1 push queued; next send 7:30pm.'], count: 1,
    summary: '3 windows, 58 checks a day · held overnight · wakes 8:00am, 9:00am' });
  assert.deepEqual(plain(v.notifications), { on: true, text: 'On', device: 'checks every 30 min until 10:00pm' });
  assert.equal(v.hold, null);
  const held = (at, s) => plain(hubView({ now: at, st: status(at, s), poll: poll(at), sidebar, rows }).hold);
  assert.deepEqual(held(t(10), notify(DEFAULTS, { snoozed_until: t(15).toISOString() })), { text: 'Notifications snoozed until 3:00pm', end: true });
  assert.deepEqual(held(t(10), notify(DEFAULTS, { snoozed_until: 'forever' })), { text: 'Notifications snoozed until you end it', end: true });
  const foreverQueue = hubView({ now: t(10), st: status(t(10), notify(DEFAULTS, { snoozed_until: 'forever' }), 1), poll: poll(t(10)), sidebar, rows });
  assert.equal(foreverQueue.polling.lines[1], '1 push queued; next send once the snooze ends.');
  assert.equal(v.awake, null);
  assert.deepEqual([t(15), 'forever'].map((awake) => hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar, rows, awake }).awake), ['until 3:00pm', 'until you turn it off']);
  assert.deepEqual(held(t(12, 0, 17), notify(DEFAULTS, { weekends_off: true })), { text: 'Notifications held for the weekend until 8:00am Mon Oct 19', end: false });
  assert.deepEqual(held(t(23), DEFAULTS), { text: 'Notifications held overnight until 8:00am tomorrow', end: false });
  assert.equal(held(t(10), notify(DEFAULTS, { on: false, snoozed_until: t(15).toISOString() })), null);
  assert.deepEqual([v.rules, v.sites, v.host, v.total, v.empty], ['2 rules', '5 sites', 'mac.ts.net', 3, false]);
  const none = hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar: { ...sidebar, sites: [] }, rows: [] });
  assert.deepEqual([none.groups, none.empty, none.rules, none.sites], [[], true, 'None yet', '0 sites']);
  assert.deepEqual(plain(siteHealth({ state: 'stopped' })), { tone: 'wait', word: 'stopped', lines: [] });
  assert.deepEqual(plain(siteHealth({ state: 'up' }, [ok('github'), { ...ok('events'), listen: 'asleep' }])), { tone: 'ok', word: 'up · asleep · every link passes', lines: [] });
  const fetchFails = { link: 'repo-fetch', ok: false, state: 'broken', detail: "git can't reach origin" };
  assert.deepEqual(plain(siteHealth({ state: 'up' }, [ok('github'), fetchFails, ok('events')])),
    { tone: 'wait', word: 'degraded · listening', lines: [{ link: 'repo-fetch', detail: "git can't reach origin" }] });
  assert.deepEqual(plain(siteHealth({ state: 'up' }, [ok('github'), { ...fetchFails, state: 'settling' }, ok('events')])),
    { tone: 'wait', word: 'up · listening · 1 settling', lines: [{ link: 'repo-fetch', detail: "settling: git can't reach origin" }] });
});

test("a device that loses its push subscription tells the hub, which forgets it; one that has it is remembered", async () => {
  const posts = [];
  const store = new Map([['kickflip.push.endpoint', 'https://push.example/old']]);
  let current = null;
  let permission = 'default';
  const registration = { pushManager: { getSubscription: async () => current && { toJSON: () => ({ endpoint: current }) } } };
  const context = vm.createContext({
    navigator: { userAgent: 'Mac', serviceWorker: { getRegistration: async () => registration } },
    PushManager: class {},
    get Notification() { return { permission }; },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    fetch: async (url, opts) => { posts.push([url, JSON.parse(opts.body).endpoint]); return { json: async () => ({}) }; },
  });
  vm.runInContext(fs.readFileSync(new URL('../board/public/hub-kit.js', import.meta.url), 'utf8'), context);
  const B = { root: {}, alive: () => true, on() {} };
  const render = () => context.HubKit.device(B, { paint() {} }).ready;
  await render();
  assert.deepEqual(posts, [['/_hub/push/unsubscribe', 'https://push.example/old']]);
  assert.equal(store.has('kickflip.push.endpoint'), false);
  await render();
  assert.equal(posts.length, 1);
  current = 'https://push.example/new';
  await render();
  assert.deepEqual(posts.slice(1), [['/_hub/push/subscribe', 'https://push.example/new']]);
  assert.equal(store.get('kickflip.push.endpoint'), 'https://push.example/new');
  current = 'https://push.example/newer';
  await render();
  assert.deepEqual(posts.slice(2), [['/_hub/push/unsubscribe', 'https://push.example/new'], ['/_hub/push/subscribe', 'https://push.example/newer']]);
  permission = 'denied';
  await render();
  assert.deepEqual(posts.slice(4), [['/_hub/push/unsubscribe', 'https://push.example/newer']]);
  assert.equal(store.has('kickflip.push.endpoint'), false);
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
  const listeners = [], opened = [];
  const context = vm.createContext({
    navigator: {},
    BoardView: { page: (root, site, run) => run({ $: (s) => root.querySelector(s), atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: { openSettings: (...args) => opened.push(args) }, mount() {}, unmount() {} }) },
    BoardUI: { header: () => '' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { device: () => ({ state: () => null }), forms: () => ({}), live: (B, opts) => { live = opts; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const sessions = [{ session: 's-alpha', rules: ['Bash(echo "<img>")', 'Write(//r/a)', 'WebFetch(domain:docs.x.dev)'] }];
  const integrations = [
    { id: 'github', name: 'GitHub', ready: false, missing: "gh isn't logged in <img>", fix: { command: 'gh auth login <img>' }, waits: 'GitHub polling and PR reports wait on this.' },
    { id: 'codex', name: 'Codex', ready: true, detail: 'Installed and logged in <img>' },
    { id: 'linear', name: 'Linear', ready: false, missing: 'No Linear key set', fix: { settings: 'linear', label: 'Hub settings › Linear', text: 'Add one in' }, waits: 'Linear moves wait on this.' },
  ];
  const data = hubView({ now, st: status(now, DEFAULTS), poll: poll(now), integrations,
    sidebar: { sites: [{ route: 'alpha', board: true }, { route: 'beta', board: true }], hub: { tone: 'wait', word: 'degraded', detail: '2 of 2 sites up · 1 link failing' }, notifications: {}, total: 0,
      usage: { claude: { at: now.toISOString(), five_hour: { used_percentage: 42, resets_at: t(20).toISOString(), state: 'live' }, seven_day: null }, codex: null } },
    rows: [{ route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'beta', title: 'Beta', state: 'up' }], remembered: new Map([['alpha', sessions]]), code: { running: 'abc', onDisk: 'abc' },
  });
  assert.deepEqual(data.groups[0].sites.map((s) => s.remembered), [sessions, []]);
  live.paint({ ...data, remembered: [{ session: 's-alone', rules: ['WebSearch'] }] });
  const labels = root.querySelectorAll('.hub-status .label').map((el) => el.textContent);
  assert.equal(data.integrations, integrations);
  assert.deepEqual(labels.slice(0, 4), ['Usage', 'Health', 'Integrations', 'Boards']);
  const label = root.querySelectorAll('.label').find((el) => el.textContent === 'Integrations');
  const group = label.nextSibling;
  assert.deepEqual(group.querySelectorAll('.title').map((el) => el.textContent), ['GitHub', 'Codex', 'Linear']);
  const [github, codex, linear] = group.querySelectorAll('.row');
  assert.equal(github.querySelector('.st.wait').textContent, 'not ready');
  assert.match(github.textContent, /gh isn't logged in <img>/);
  assert.equal(github.querySelector('code').textContent, 'gh auth login <img>');
  assert.equal(github.querySelector('.rd-waits').textContent, integrations[0].waits);
  assert.match(github.querySelector('.icon').getAttribute('style'), /var\(--color-notice\)/);
  assert.equal(codex.querySelector('.st.ok').textContent, 'ready');
  assert.match(codex.textContent, /Installed and logged in <img>/);
  assert.match(codex.querySelector('.icon').getAttribute('style'), /var\(--color-quiet\)/);
  assert.equal(linear.querySelector('[data-settings-open="linear"]').textContent, 'Hub settings › Linear');
  const link = linear.querySelector('[data-settings-open="linear"]');
  listeners.find((l) => l.target === root.querySelector('.hub-status') && l.type === 'click').fn({ target: link });
  assert.deepEqual(plain(opened[0][0]), { hash: '#linear' });
  assert.equal(opened[0][1], link);
  assert.match(linear.querySelector('.rd-fix').textContent, /Add one in Hub settings › Linear\./);
  const health = root.querySelector('[data-jump="integrations"]');
  assert.deepEqual([health.textContent, health.getAttribute('class')], ['degraded', 'st wait']);
  let scrolled = 0;
  root.querySelector('#integrations').scrollIntoView = () => { scrolled++; };
  listeners.find((l) => l.target === root.querySelector('.hub-status') && l.type === 'click').fn({ target: health });
  assert.equal(scrolled, 1);
  assert.equal(group.querySelector('img'), null);
  const note = group.nextSibling.nodeType === 3 ? group.nextSibling.nextSibling : group.nextSibling;
  assert.equal(note.textContent, 'A feature that needs an integration stays off until it’s ready, and says why.');
  assert.match(root.querySelector('.usage').textContent, /Claude.*5-hour.*42%/);
  assert.equal(root.querySelector('.usage').querySelectorAll('details, dialog').length, 0);
  assert.ok(root.querySelector('.usage [aria-label="Codex share"]').querySelectorAll('button').every((el) => el.hasAttribute('disabled')));
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

// docs/adr/2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md
test("the hub's runs-older-code notice jumps to Restart hub, which confirms, waits for the hub's answer, says restarting… and reloads once the hub answers with its new code", async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  let live, confirmed = true, reloads = 0;
  const listeners = [], asked = [], requests = [];
  // Each request waits for the test to answer it.
  const answers = [];
  const answer = (status, body, code) => answers.shift()({ ok: status < 400, status, json: async () => body, headers: { get: (k) => (k === 'x-hub-code' ? code : null) } });
  const context = vm.createContext({
    navigator: {},
    setTimeout: (fn) => Promise.resolve().then(fn),
    BoardView: { page: (root, site, run) => run({ $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    BoardDialogs: { confirm: async (text) => { asked.push(text); return confirmed; } },
    AppShell: { reload: () => { reloads++; } },
    fetch: (url, init = {}) => { requests.push([url, init.method || 'GET', init.body]); return new Promise((resolve) => answers.push(resolve)); },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { header: () => '' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { forms: () => ({}), live: (B, opts) => { live = opts; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  document.body = root;
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const view = (code) => hubView({ now, st: status(now, DEFAULTS), poll: poll(now), rows: [], code,
    sidebar: { sites: [], hub: { tone: 'wait', word: 'degraded', detail: '0 of 0 sites up · runs older code than its files; restart it' }, notifications: {}, total: 0 } });
  const click = (target) => listeners.find((l) => l.target === root.querySelector('.hub-status') && l.type === 'click').fn({ target });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  live.paint(view({ running: 'abc', onDisk: 'abc' }));
  assert.equal(root.querySelector('[data-restart-hub]'), null);
  assert.ok(root.querySelector('[data-jump="integrations"]'));

  live.paint(view({ running: 'old', onDisk: 'abc' }));
  const notice = root.querySelector('[data-jump="restart-hub"]');
  assert.equal(notice.textContent, 'degraded');
  const button = root.querySelector('#restart-hub');
  assert.equal(button.textContent, 'Restart hub');
  let scrolled = 0;
  button.scrollIntoView = () => { scrolled++; };
  click(notice);
  assert.equal(scrolled, 1);
  assert.equal(document.activeElement, button);
  assert.deepEqual(requests, []);

  confirmed = false;
  click(button);
  await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Restart the hub\?$/);
  assert.deepEqual(requests, []);

  confirmed = true;
  click(root.querySelector('#restart-hub'));
  await settle();
  assert.deepEqual(requests, [['/_hub/restart-hub', 'POST', '{}']]);
  assert.equal(root.querySelector('#restart-hub').textContent, 'restarting…');
  assert.ok(root.querySelector('#restart-hub').hasAttribute('disabled'));

  // A refusal says why, and the button comes back.
  answer(409, { error: 'The hub is already restarting.' }, 'old');
  await settle();
  assert.equal(root.querySelector('[role="alert"]').textContent, 'The hub is already restarting.');
  assert.equal(root.querySelector('#restart-hub').textContent, 'Restart hub');

  click(root.querySelector('#restart-hub'));
  await settle();
  answer(200, { restarting: true, command: 'launchctl kickstart -k gui/$(id -u)/local.claude.kickflip-hub' }, 'old');
  await settle();
  assert.equal(root.querySelector('#restart-hub').textContent, 'restarting…');
  assert.deepEqual(requests.at(-1), ['/_hub/api/hub', 'GET', undefined]);
  answers.shift()(Promise.reject(new Error('down')));
  await settle();
  answer(200, view({ running: 'old', onDisk: 'abc' }), 'old');
  await settle();
  assert.equal(reloads, 0);
  answer(200, view({ running: 'abc', onDisk: 'abc' }), 'abc');
  await settle();
  assert.equal(reloads, 1);
});

test("the hub page's Usage card opens Codex's block with Codex share, bars under it unless Off, greys it out while Codex isn't usable, and saves each choice or shows a refusal", async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  const listeners = [];
  const posts = [];
  let live;
  let refused = false;
  let sidebarChanges = 0;
  const now = t(19);
  const reading = { at: now.toISOString(), five_hour: { used_percentage: 42, resets_at: t(20).toISOString(), state: 'live' }, seven_day: null };
  const hub = (codexShare, codex = USABLE) => plain(hubView({ now, st: status(now, DEFAULTS), poll: poll(now), rows: [], codexShare, codex,
    sidebar: { sites: [], hub: {}, notifications: {}, total: 0, usage: { claude: reading, codex: codex.usable && codexShare !== 'off' ? reading : null } } }));
  const context = vm.createContext({
    URLSearchParams, document, navigator: {},
    FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { header: () => '' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    fetch: async (url, opts) => {
      posts.push({ url, opts });
      return { ok: !refused, json: async () => refused ? { error: 'codex-share takes auto, always, or off' } : hub(opts.body.get('value')) };
    },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'hub-kit.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  context.HubKit.live = (B, opts) => { live = opts; return () => {}; };
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', { sidebarChanged: () => sidebarChanges++ });
  const codex = () => root.querySelectorAll('.usage .u-block').at(-1);
  const selected = () => codex().querySelector('.segments button[aria-pressed="true"]').value;
  const submit = (value) => {
    const form = codex().querySelector('.segments');
    const button = form.querySelector(`button[value="${value}"]`);
    return listeners.find((l) => l.target === root && l.type === 'submit').fn({ target: form,
      submitter: { name: button.getAttribute('name'), value: button.value }, preventDefault() {} });
  };

  for (const [status, tag, words, fix] of [
    [NOT_INSTALLED, 'not installed', "Codex isn't installed on the host.", process.platform === 'darwin' ? 'brew install --cask codex' : 'npm i -g @openai/codex'],
    [LOGGED_OUT, 'not logged in', "Codex isn't logged in on the host.", 'codex login'],
  ]) {
    live.paint(hub('off', status));
    assert.equal(codex().textContent, `Codex${tag}Always onAutoOff${words}${fix}`);
    assert.equal(codex().querySelector('.u-share-fix code').textContent, fix);
    assert.equal(codex().querySelector('.segments').getAttribute('aria-disabled'), 'true');
    assert.deepEqual(codex().querySelectorAll('.segments button').map((b) => b.hasAttribute('disabled')), [true, true, true]);
    assert.equal(selected(), 'off');
    assert.equal(codex().querySelectorAll('.u-bar').length, 0);
  }

  live.paint(hub('off'));
  assert.match(codex().textContent, /^CodexAlways onAutoOffClaude implements and reviews\./);
  assert.equal(codex().querySelector('.u-asof'), null);
  assert.equal(codex().querySelectorAll('.u-bar, .u-share-fix, [disabled], [aria-disabled]').length, 0);
  assert.equal(selected(), 'off');
  assert.deepEqual(codex().querySelectorAll('.segments button').map((b) => b.textContent), ['Always on', 'Auto', 'Off']);
  assert.equal(codex().querySelector('.segments').getAttribute('aria-label'), 'Codex share');
  assert.equal(codex().querySelector('.u-share-desc').textContent, 'Claude implements and reviews.');
  assert.deepEqual(root.querySelectorAll('.usage .u-head .title').map((el) => el.textContent), ['Claude', 'Codex']);

  for (const value of ['auto', 'always', 'off']) {
    await submit(value);
    const { url, opts } = posts.at(-1);
    assert.deepEqual([url, opts.method, opts.headers.accept, opts.body.toString()], ['/_hub/settings/codex', 'POST', 'application/json', `value=${value}`]);
    assert.equal(selected(), value);
    assert.equal(codex().querySelector('.u-share-desc').textContent, hub(value).codex.description);
    assert.equal(codex().querySelectorAll('.u-bar').length, value === 'off' ? 0 : 2);
    assert.match(codex().textContent, value === 'off' ? /^CodexAlways onAutoOffClaude implements and reviews\./ : /^Codexread [^]*?Always onAutoOff[^]*?(?:runs out|it's out)\.5-hour42% · resets/);
  }
  assert.equal(sidebarChanges, 3);
  refused = true;
  await submit('auto');
  assert.equal(selected(), 'off');
  assert.equal(root.querySelector('[role="alert"]').textContent, 'codex-share takes auto, always, or off');
});

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
test("the hub page's Usage card opens Claude's block with Opus, Auto and Sonnet, whose helper says what Auto does, and saves each choice or shows a refusal", async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  const listeners = [];
  const posts = [];
  let live;
  let refused = false;
  const now = t(19);
  const reading = { at: now.toISOString(), five_hour: { used_percentage: 42, resets_at: t(20).toISOString(), state: 'live' }, seven_day: null };
  const hub = (claudeModel, claude = reading) => plain(hubView({ now, st: status(now, DEFAULTS), poll: poll(now), rows: [], codexShare: 'off', codex: USABLE, claudeModel,
    sidebar: { sites: [], hub: {}, notifications: {}, total: 0, usage: { claude, codex: null } } }));
  const context = vm.createContext({
    URLSearchParams, document, navigator: {},
    FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { header: () => '' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    fetch: async (url, opts) => {
      posts.push({ url, opts });
      return { ok: !refused, json: async () => refused ? { error: 'claude-model takes opus, auto or sonnet' } : hub(opts.body.get('value')) };
    },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'hub-kit.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  context.HubKit.live = (B, opts) => { live = opts; return () => {}; };
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', {});
  const claude = () => root.querySelectorAll('.usage .u-block')[0];
  const selected = () => claude().querySelector('.segments button[aria-pressed="true"]').value;
  const submit = (value) => {
    const form = claude().querySelector('.segments');
    const button = form.querySelector(`button[value="${value}"]`);
    return listeners.find((l) => l.target === root && l.type === 'submit').fn({ target: form,
      submitter: { name: button.getAttribute('name'), value: button.value }, preventDefault() {} });
  };
  const HELP = {
    opus: 'Always Opus. Auto would give small cards to Sonnet.',
    auto: 'Auto: small cards get Sonnet, the rest get Opus.',
    sonnet: 'Always Sonnet. Auto would give large cards to Opus.',
  };

  live.paint(hub('auto'));
  assert.equal(claude().querySelector('.u-head .title').textContent, 'Claude');
  assert.equal(claude().querySelector('.segments').getAttribute('aria-label'), 'Claude model');
  assert.equal(claude().querySelector('.segments').getAttribute('action'), '/_hub/settings/claude-model');
  assert.deepEqual(claude().querySelectorAll('.segments button').map((b) => b.textContent), ['Opus', 'Auto', 'Sonnet']);
  assert.match(claude().textContent, /^Claude.*OpusAutoSonnetAuto: small cards get Sonnet, the rest get Opus\.5-hour42%/);
  assert.equal(selected(), 'auto');
  for (const value of ['opus', 'sonnet', 'auto']) {
    await submit(value);
    const { url, opts } = posts.at(-1);
    assert.deepEqual([url, opts.method, opts.body.toString()], ['/_hub/settings/claude-model', 'POST', `value=${value}`]);
    assert.equal(selected(), value);
    assert.equal(claude().querySelector('.u-share-desc').textContent, HELP[value]);
  }
  refused = true;
  await submit('opus');
  assert.equal(selected(), 'auto');
  assert.equal(root.querySelector('[role="alert"]').textContent, 'claude-model takes opus, auto or sonnet');

  // With no Claude reading yet, the block still opens with the control.
  live.paint(hub('sonnet', null));
  assert.deepEqual(root.querySelectorAll('.usage .u-head .title').map((el) => el.textContent), ['Claude', 'Codex']);
  assert.equal(selected(), 'sonnet');
});

test("the hub page leads with a banner while pushes are held or snoozed, and its End snooze lifts a snooze", async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  const listeners = [];
  const posts = [];
  let live;
  let loads = 0;
  let settingsRefreshes = 0;
  let sidebarChanges = 0;
  let settingsCtx;
  const now = t(10);
  const page = (n) => plain(hubView({ now, st: status(now, notify(DEFAULTS, n)), poll: poll(now), rows: [], sidebar: { sites: [], hub: {}, notifications: {}, total: 0 } }));
  const context = vm.createContext({
    URLSearchParams, document, navigator: {},
    FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: (el, site, ctx) => { settingsCtx = ctx; return { B: { refreshSettings: () => settingsRefreshes++ }, mount() {}, unmount() {} }; } },
    BoardUI: { header: () => '' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    fetch: async (url, opts) => { posts.push({ url, opts }); return { ok: true, json: async () => ({}) }; },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'hub-kit.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  context.HubKit.live = (B, opts) => { live = opts; return () => { loads++; }; };
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', { sidebarChanged: () => sidebarChanges++ });
  const banner = () => root.querySelector('.hub-status .hold-banner');

  live.paint(page({}));
  assert.equal(banner(), null);

  const weekend = plain(hubView({ now: t(12, 0, 17), st: status(t(12, 0, 17), notify(DEFAULTS, { weekends_off: true })), poll: poll(now), rows: [], sidebar: { sites: [], hub: {}, notifications: {}, total: 0 } }));
  live.paint(weekend);
  assert.equal(banner().textContent, 'Notifications held for the weekend until 8:00am Mon Oct 19');
  assert.equal(banner().querySelectorAll('button, form').length, 0);
  assert.equal(root.querySelector('.hub-status').firstChild, banner());

  live.paint(page({ snoozed_until: t(15).toISOString() }));
  assert.match(banner().textContent, /^Notifications snoozed until 3:00pm\s*End snooze$/);
  const form = banner().querySelector('form');
  const button = form.querySelector('button');
  await listeners.find((l) => l.target === root && l.type === 'submit').fn({ target: form, submitter: { name: button.getAttribute('name'), value: button.value }, preventDefault() {} });
  const { url, opts } = posts.at(-1);
  assert.deepEqual([url, opts.method, opts.headers.accept, opts.body.toString()], ['/_hub/settings/notifications', 'POST', 'application/json', 'snooze=off']);
  assert.deepEqual([loads, settingsRefreshes, sidebarChanges], [1, 1, 1]);

  settingsCtx.sidebarChanged();
  assert.deepEqual([loads, sidebarChanges], [2, 2]);
});

test('the pause stepper and banner forms save in place, refresh the sidebar and toast Keep going and Stop', async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  const listeners = [];
  const posts = [];
  const toasts = [];
  let live;
  let changed = 0;
  let gate = { pause_at: 90, state: 'paused', used: 91, window: 'five_hour', resets_at: new Date(Date.now() + 3600_000).toISOString() };
  const data = () => ({ integrations: [], pause: { ...gate }, usage: { claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: gate.resets_at, state: 'live' } } }, hub: {}, groups: [], polling: { title: '', lines: [] } });
  const context = vm.createContext({
    URLSearchParams, document, navigator: {}, FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), toast: (text) => toasts.push(text), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { header: () => '' }, PromptAnswers: { wire: () => ({ shows: () => true }) },
    fetch: async (url, opts) => {
      posts.push([url, opts.method, opts.body.toString()]);
      if (url.endsWith('/pause-at')) gate.pause_at = Number(opts.body.get('value'));
      else gate.state = opts.body.get('value') === 'on' ? 'going' : 'paused';
      return { ok: true, json: async () => data() };
    },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'hub-kit.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  context.HubKit.live = (B, opts) => { live = opts; return () => {}; };
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', { sidebarChanged: () => changed++ });
  live.paint(data());
  const submit = async (selector, value) => {
    const form = root.querySelector(selector);
    const button = form.querySelector(`button[value="${value}"]`);
    assert.ok(button);
    await listeners.find((l) => l.target === root && l.type === 'submit').fn({ target: form, submitter: { name: 'value', value }, preventDefault() {} });
  };
  await submit('.ub-step', '85');
  assert.match(root.querySelector('.ub-step output').textContent, /85%/);
  await submit('.ub-banner form', 'on');
  assert.ok(root.querySelector('.ub-going'));
  assert.match(toasts[0], /Keep going: work runs past the buffer until .*\./);
  await submit('.ub-banner form', 'off');
  assert.ok(root.querySelector('.ub-paused'));
  assert.equal(toasts[1], 'Stopped: new work waits again.');
  assert.equal(changed, 3);
  assert.deepEqual(posts, [['/_hub/settings/pause-at', 'POST', 'value=85'], ['/_hub/settings/keep-going', 'POST', 'value=on'], ['/_hub/settings/keep-going', 'POST', 'value=off']]);
});
