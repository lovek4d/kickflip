import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from '../board/mini-dom.mjs';
import { DEFAULTS, hold, flushAt, snoozeEnd } from './schedule.mjs';
import { durationEnd } from './duration.mjs';
import { hubView, settingsView, siteHealth, flushView } from './views.mjs';
import { codexStatus } from '../shared/codex.mjs';

// The gate as readUsageGate reads it with no pause and a calm Mac, which every hub page carries.
const CALM_GATE = { pause_at: 90, state: 'normal', manual: null, window: null, used: null, resets_at: null, machine: { state: 'normal', reason: null } };

const t = (h, m = 0, day = 14, s = 0) => new Date(2026, 9, day, h, m, s);
const ON = { on: true, weekends_off: false, snoozed_until: null };
const notify = (s, n) => ({ ...s, notifications: { ...ON, ...n } });
const status = (now, s, count = 0) => ({ settings: s, hold: hold(now, s), count, nextFlushAt: count ? flushAt(now, s) : null });
const plain = (v) => JSON.parse(JSON.stringify(v));
// The hub views wait on ui.js waitOn and draw its BUSY; board/view.test.mjs tests how a waiting control looks.
const BOARD_UI = { header: () => '', BUSY: ' disabled aria-busy="true"', waitOn: (control, promise) => promise, onBackdrop: (ev, backdrop) => ev.target === backdrop, swipeToDismiss: () => () => {}, newStrip: () => '' };
const USABLE = { usable: true, reason: null, words: null, fix: null };
const NOT_INSTALLED = codexStatus({ installed: false });
const LOGGED_OUT = codexStatus({ installed: true, home: '/nonexistent' });

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test("Pause hub offers the snooze picker's chips, Forever included, then says until when with Resume", () => {
  const now = t(10);
  const v = settingsView({ now, st: status(now, DEFAULTS) });
  const off = plain(v.pause);
  assert.deepEqual(off, { on: null, summary: 'Off', choices: [['1h', '1h', 'until 11:00am'], ['3h', '3h', 'until 1:00pm'], ['6h', '6h', 'until 4:00pm'], ['1d', '1d', 'until 10:00am tomorrow'], ['forever', 'Forever', 'until you resume']].map(([value, label, until]) => ({ value, label, until })) });
  const values = (choices) => choices.map((c) => [c.value, c.label]);
  assert.deepEqual(values(v.pause.choices), values(v.snooze.choices), 'the same set as Snooze');
  assert.deepEqual(plain(settingsView({ now, st: status(now, DEFAULTS), pausedUntil: t(13) }).pause), { on: { title: 'Paused until 1:00pm' }, summary: 'Paused until 1:00pm', choices: null });
  assert.deepEqual(plain(settingsView({ now, st: status(now, DEFAULTS), pausedUntil: 'forever' }).pause), { on: { title: 'Paused until you resume' }, summary: 'Paused · forever', choices: null });
});

test('Quiet hours shows its start and end, the hold, the cadence hint and what each snooze, the weekend and the wake read', () => {
  const now = t(19);
  const v = settingsView({ now, st: status(now, DEFAULTS) }).quiet;
  assert.deepEqual([v.start, v.end, v.summary, v.hint], ['22:00', '08:00', '10:00pm – 8:00am · pushes held', "checks every minute while you're here, every 5 when away"]);
  assert.deepEqual(plain(v.hold), { on: true, sub: 'Pushes queued after 10:00pm wait until 8:00am. Urgent ones still go.' });
  assert.deepEqual(plain(v.reads), [
    { title: 'Snooze tonight', sub: 'Until 10:00pm, then quiet hours hold pushes until 8:00am tomorrow.' },
    { title: 'Snooze morning', sub: 'Until 8:00am tomorrow.' },
    { title: 'Snooze monday', sub: 'Until 8:00am Mon Oct 19.' },
    { title: 'Off on weekends', sub: 'Off.' },
  ]);
  const open = settingsView({ now, st: status(now, notify({ ...DEFAULTS, quiet: { start: '23:00', end: '07:30', hold: false } }, { weekends_off: true })) }).quiet;
  assert.deepEqual([open.summary, open.hold.sub, open.reads[0].sub, open.reads[3].sub],
    ['11:00pm – 7:30am', 'Off. Pushes go out all night.', 'Until 11:00pm.', 'Pushes wait from Friday 11:00pm until Monday 7:30am.']);
});

test('Hub Settings says whether pushes go, when a snooze ends and what each snooze choice would end at', () => {
  const now = t(10);
  const v = settingsView({ now, st: status(now, DEFAULTS), rules: [{ id: 'r1', text: 'Be brief' }] });
  assert.equal(v.snoozed, null);
  assert.deepEqual(plain(v.on), { on: true, sub: 'On. Turn off to drop every push, urgent ones too.',
    confirm: 'Turn off notifications? Every push is dropped until you turn them back on, urgent ones too. Needs you and the badge still update.' });
  assert.deepEqual(plain(v.weekends), { on: false, sub: 'Pushes wait from Friday 10:00pm until Monday 8:00am. Urgent ones still go.' });
  assert.equal(v.quiet.summary, '10:00pm – 8:00am · pushes held');
  assert.equal(v.device, 'pushes go out after each check');
  assert.deepEqual(v.snooze.choices.map((c) => [c.value, c.label, c.until]), [['1h', '1h', 'until 11:00am'], ['3h', '3h', 'until 1:00pm'], ['6h', '6h', 'until 4:00pm'],
    ['1d', '1d', 'until 10:00am tomorrow'], ['forever', 'Forever', 'until you end it']]);
  assert.equal(v.awake, undefined);
  assert.deepEqual(plain(v.rules), [{ id: 'r1', text: 'Be brief' }]);

  const snoozed = settingsView({ now, st: status(now, notify(DEFAULTS, { snoozed_until: t(12).toISOString() }), 2) });
  assert.deepEqual(plain(snoozed.snoozed), { title: 'Snoozed until 12:00pm', summary: 'Snoozed until 12:00pm' });
  assert.equal(snoozed.snooze, null);
  assert.equal(snoozed.device, 'snoozed until 12:00pm');
  assert.match(snoozed.on.confirm, / The 2 queued pushes are dropped now\. /);

  const forever = settingsView({ now, st: status(now, notify(DEFAULTS, { snoozed_until: 'forever' }), 2) });
  assert.deepEqual(plain(forever.snoozed), { title: 'Snoozed until you end it', summary: 'Snoozed · forever' });
  assert.equal(forever.snooze, null);
  assert.equal(forever.device, 'snoozed until you end it');

  const off = settingsView({ now, st: status(now, notify(DEFAULTS, { on: false, snoozed_until: t(12).toISOString() })) });
  assert.deepEqual([off.snoozed, off.snooze], [null, null]);
  assert.deepEqual([off.on.on, off.on.sub], [false, 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.']);
  assert.equal(off.device, 'notifications are off');
});

test("the hub page's Codex share says what each choice means while Codex is usable, why not and what to run while it isn't, and Hub Settings no longer carries it", () => {
  const now = t(10);
  const sidebar = { sites: [], hub: {}, notifications: {}, total: 0, usage: { claude: null, codex: null } };
  const view = (extra = {}) => hubView({ now, st: status(now, DEFAULTS), sidebar, rows: [], ...extra }).codex;
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

test('Hub settings modals keep summaries, turn this device on, snooze inline through one duration picker and Linear and Slack keys in modals with no summary rows, with no Codex share row or modal', async () => {
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
  let slack = { set: false };
  let checked = null;
  let pausedUntil = null;
  const overnight = [{ id: 'wake', title: 'Daily wake', icon: 'calendar', does: (w) => `Wakes every board once at ${w.end}, when quiet hours end.`, on: true, last: { at: t(8).toISOString(), failed: 'failed on alpha', href: '/alpha/' } }];
  const data = (notifications = ON) => settingsView({ now, st: status(now, notify(DEFAULTS, notifications)), linear, slack, pausedUntil, overnight });
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
    BoardDialogs: { fitSheet: () => () => {}, confirm: async () => confirmed }, BoardUI: { ...BOARD_UI },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { userAgent: 'Mac', serviceWorker: { getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration) } },
    PushManager: class {},
    Notification: { permission: 'default', requestPermission: () => { requested = true; return Promise.resolve('granted'); } },
    FormData: class {
      constructor(form) { this.form = form; }
      *[Symbol.iterator]() { for (const el of this.form.querySelectorAll('input[name]')) if (el.getAttribute('type') !== 'checkbox' || el.hasAttribute('checked')) yield [el.getAttribute('name'), el.value]; }
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
      if (url === '/_hub/settings/slack') {
        slack = opts.body.has('remove') ? { set: false } : { set: true, team: 'Acme', user: 'love' };
        return { ok: true, json: async () => data() };
      }
      if (url === '/_hub/settings/notifications') {
        const choice = opts.body.get('snooze');
        const end = choice === 'off' ? null : snoozeEnd(now, choice, DEFAULTS);
        return { ok: true, json: async () => data({ ...ON, snoozed_until: end === 'forever' ? end : end?.toISOString() || null }) };
      }
      if (url === '/_hub/settings/hub-pause') {
        const choice = opts.body.get('pause');
        pausedUntil = choice === 'off' ? null : durationEnd(now, choice);
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
  assert.deepEqual(root.querySelectorAll('.hub-setting .title').map((h) => h.textContent), ['Pause hub', 'Notifications', 'Appearance', 'Quiet hours', 'Rules for every board', 'Closed boards']);
  assert.deepEqual(root.querySelectorAll('form input[name="set"]').map((input) => input.value), ['on', 'weekends']);
  assert.deepEqual(root.querySelectorAll('.dur-choices button').map((b) => b.textContent), ['1h', '3h', '6h', '1d', 'Forever']);
  assert.equal(root.querySelector('.dur-custom .btn').textContent, 'Custom');
  assert.equal(root.querySelectorAll('dialog').length, 1);
  assert.equal(modal.open, true);
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
  assert.equal(root.querySelector('[data-summary="quiet"]').textContent, '10:00pm – 8:00am · pushes held');
  await B.openSettings({ hash: '#quiet' });
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Quiet hours');
  assert.deepEqual(root.querySelectorAll('input[type="time"]').map((el) => [el.getAttribute('name'), el.value, el.hasAttribute('data-autosave'), el.closest('form').getAttribute('action')]),
    [['start', '22:00', true, '/_hub/settings/quiet'], ['end', '08:00', true, '/_hub/settings/quiet']]);
  assert.equal(root.querySelector('input[name="set"][value="hold"]').closest('form').querySelector('input.toggle').hasAttribute('checked'), true);
  assert.equal(root.querySelector('.quiet-hint').textContent, "checks every minute while you're here, every 5 when away");
  assert.deepEqual(root.querySelectorAll('.setting-content .label').map((h) => h.textContent), ['Overnight work', 'Snoozes and weekends read']);
  assert.match(root.querySelector('.setting-content').textContent, /Starts at 3:00am, the middle of quiet hours\./);
  const wakeForm = root.querySelector('input[name="job"][value="wake"]').closest('form');
  assert.equal(wakeForm.getAttribute('action'), '/_hub/settings/overnight');
  assert.match(wakeForm.textContent, /Daily wake.*Wakes every board once at 8:00am, when quiet hours end\..*Last run 8:00am · failed on alpha/);
  assert.equal(wakeForm.querySelector('.run.failed a').getAttribute('href'), '/alpha/');
  assert.equal(wakeForm.querySelector('input.toggle').hasAttribute('checked'), true);
  assert.equal(wakeForm.querySelector('input.toggle').hasAttribute('data-submit'), true);
  // docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
  assert.equal(root.querySelector('[data-summary="pause"]').textContent, 'Off');
  await B.openSettings({ hash: '#pause' });
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Pause hub');
  assert.match(root.querySelector('.setting-content').textContent, /No new builders, planners or pulls start on any board until then/);
  assert.deepEqual(root.querySelectorAll('.dur-choices button').map((b) => [b.textContent, b.getAttribute('name')]), [['1h', 'pause'], ['3h', 'pause'], ['6h', 'pause'], ['1d', 'pause'], ['Forever', 'pause']]);
  const pauseChips = root.querySelector('.dur-choices');
  await submitForm(pauseChips, pauseChips.querySelector('button[value="3h"]'));
  assert.deepEqual([posts.at(-1).url, posts.at(-1).opts.body.toString()], ['/_hub/settings/hub-pause', 'pause=3h']);
  assert.equal(root.querySelector('.dur-on .title').textContent, 'Paused until 1:00pm');
  assert.equal(root.querySelector('[data-summary="pause"]').textContent, 'Paused until 1:00pm');
  const resume = root.querySelector('.dur-on form');
  assert.equal(resume.querySelector('button').textContent, 'Resume');
  await submitForm(resume, resume.querySelector('button'));
  assert.equal(posts.at(-1).opts.body.toString(), 'pause=off');
  assert.equal(root.querySelector('[data-summary="pause"]').textContent, 'Off');
  await B.openSettings({ kind: 'hub' });
  assert.equal(root.querySelector('.dur-choices'), null);
  await B.openSettings({ hash: '#codex' });
  assert.equal(modal.open, false);
  assert.equal(root.querySelector('.segments'), null);
  assert.equal(modal.open, false);
  // Linear and Slack open from their Integrations rows (docs/adr/2026-11-09-2230-linear-and-slack-keys-open-in-modals-from-their-integrations-rows.md), with no summary row.
  assert.equal(root.querySelector('[data-summary="linear"]'), null);
  assert.equal(root.querySelector('[data-summary="slack"]'), null);
  await B.openSettings({ hash: '#linear' });
  assert.equal(modal.open, true);
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Linear');
  assert.equal(root.querySelector('.settings-head .muted').textContent, 'Integrations');
  const content = root.querySelector('.setting-content');
  assert.equal(root.querySelector('[data-linear-remove]'), null);
  assert.equal(root.querySelector('.lk-form button'), null);
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
  await B.openSettings({ hash: '#linear' });
  assert.match(content.textContent, /doesn’t work · Linear refused the key/);
  assert.ok(content.querySelector('a[href="https://linear.app/settings/account/security"]'));
  assert.ok(content.querySelector('[data-linear-remove]'));
  const keyInput = root.querySelector('#linearKey');
  keyInput.value = '';
  await fire(content, 'submit', { target: root.querySelector('.lk-form') });
  assert.equal(posts.at(-1).opts.body.toString(), 'key=bad');
  keyInput.value = 'lin_api_secret123';
  await fire(content, 'change', { target: keyInput });
  await settle();
  assert.equal(posts.at(-1).opts.body.toString(), 'key=lin_api_secret123');
  assert.match(content.textContent, /Acme workspace/);
  assert.equal(content.querySelector('a[href="https://linear.app/settings/account/security"]'), null);
  assert.doesNotMatch(root.innerHTML, /secret123/);
  confirmed = false;
  await fire(content, 'click', { target: content.querySelector('[data-linear-remove]') });
  assert.equal(posts.at(-1).opts.body.toString(), 'key=lin_api_secret123');
  confirmed = true;
  await fire(content, 'click', { target: content.querySelector('[data-linear-remove]') });
  await settle();
  assert.equal(posts.at(-1).opts.body.toString(), 'remove=1');
  assert.equal(content.querySelector('[data-linear-remove]'), null);

  await B.openSettings({ hash: '#slack' });
  assert.equal(root.querySelector('#hubSettingsTitle').textContent, 'Slack');
  const slackSlot = root.querySelector('.setting-content');
  const appLink = slackSlot.querySelector('a[href^="https://api.slack.com/apps?new_app=1&manifest_json="]');
  assert.equal(appLink.textContent, 'a new Slack app');
  assert.deepEqual(JSON.parse(new URL(appLink.getAttribute('href')).searchParams.get('manifest_json')).oauth_config.scopes.user, ['chat:write', 'emoji:read', 'im:history', 'im:write', 'reactions:write', 'search:read', 'users:read']);
  assert.match(slackSlot.textContent, /User OAuth Token \(xoxp-…\)/);
  assert.match(slackSlot.textContent, /The hub sends your reviewers their PR links, git_merged reactions and weekday digests as you, in your DMs with them\./);
  await fire(slackSlot, 'paste', { target: root.querySelector('#slackToken'), clipboardData: { getData: () => ' xoxp-secret-token ' } });
  await settle();
  assert.equal(posts.at(-1).url, '/_hub/settings/slack');
  assert.equal(posts.at(-1).opts.body.toString(), 'token=xoxp-secret-token');
  assert.match(slackSlot.textContent, /sends as love/);
  assert.doesNotMatch(root.innerHTML, /xoxp-secret/);
  await fire(slackSlot, 'click', { target: slackSlot.querySelector('[data-slack-remove]') });
  await settle();
  assert.equal(posts.at(-1).opts.body.toString(), 'remove=1');
  assert.equal(slackSlot.querySelector('[data-slack-remove]'), null);
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
  const v = hubView({ now, st: status(now, DEFAULTS, 1), sidebar, rows, links: new Map(Object.entries(links)), code: { running: 'abc', onDisk: 'abc' }, host: 'mac.ts.net', version: '0.4.2', rules: [{ text: 'a' }, { text: 'b' }] });
  assert.equal(v.version, '0.4.2');
  assert.deepEqual(v.groups.map((g) => [g.label, g.sites.map((s) => [s.route, s.tone, s.word, s.href])]), [
    ['Boards', [['alpha', 'ok', 'up · listening · every link passes', '/alpha/'], ['beta', 'wait', 'degraded · not listening', '/beta/'],
      ['gone', 'down', 'down · restarting', '/gone/'], ['new', 'wait', 'starting', '/new/']]],
    ['Pages', [['learn', 'ok', 'up', '/learn/']]],
  ]);
  assert.deepEqual(plain(v.groups[0].sites[1].lines), [{ link: 'events', detail: 'no watcher since 6:00pm' }, { link: 'wakes', detail: 'settling: missed 9:00am' }]);
  assert.match(v.groups[0].sites[0].icon, /^<span class="icon/);
  assert.deepEqual(plain(v.hub), { tone: 'down', word: '1 site down', detail: '3 of 5 sites up · 1 link failing · runs the code in its files (abc)', restart: false });
  const staleHub = { tone: 'wait', word: 'degraded', detail: '3 of 5 sites up · runs older code than its files; restart it' };
  assert.deepEqual(plain(hubView({ now, st: status(now, DEFAULTS), sidebar: { ...sidebar, hub: staleHub }, rows, code: { running: 'old', onDisk: 'abc' } }).hub), { ...staleHub, restart: true });
  assert.equal(v.polling, undefined);
  assert.deepEqual(plain(v.notifications), { on: true, text: 'On', device: 'pushes go out after each check' });
  assert.equal(v.hold, null);
  const held = (at, s) => plain(hubView({ now: at, st: status(at, s), sidebar, rows }).hold);
  assert.deepEqual(held(t(10), notify(DEFAULTS, { snoozed_until: t(15).toISOString() })), { text: 'Notifications snoozed until 3:00pm', end: true });
  assert.deepEqual(held(t(10), notify(DEFAULTS, { snoozed_until: 'forever' })), { text: 'Notifications snoozed until you end it', end: true });
  assert.deepEqual(plain(v.awake), { on: false, unsupported: null });
  assert.deepEqual(plain(hubView({ now, st: status(now, DEFAULTS), sidebar, rows, awake: { on: true, unsupported: null } }).awake), { on: true, unsupported: null });
  assert.deepEqual(held(t(12, 0, 17), notify(DEFAULTS, { weekends_off: true })), { text: 'Notifications held for the weekend until 8:00am Mon Oct 19', end: false });
  assert.deepEqual(held(t(23), DEFAULTS), { text: 'Notifications held overnight until 8:00am tomorrow', end: false });
  assert.equal(held(t(10), notify(DEFAULTS, { on: false, snoozed_until: t(15).toISOString() })), null);
  assert.deepEqual([v.rules, v.host, v.total, v.empty], ['2 rules','mac.ts.net', 3, false]);
  const none = hubView({ now, st: status(now, DEFAULTS), sidebar: { ...sidebar, sites: [] }, rows: [] });
  assert.deepEqual([none.groups, none.empty, none.rules], [[], true, 'None yet']);
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

test('the hub page shows each session\'s remembered rules under its board, escaped and read-only', async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  let live, loads = 0;
  const listeners = [], opened = [];
  const context = vm.createContext({
    navigator: {}, localStorage: { getItem: () => 'mine' },
    BoardView: { page: (root, site, run) => run({ $: (s) => root.querySelector(s), atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: { openSettings: (...args) => opened.push(args) }, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI, ago: (iso) => (Date.now() - Date.parse(iso) > 3600_000 ? '2h ago' : '5m ago') },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { device: () => ({ state: () => null }), forms: () => ({}), live: (B, opts) => { live = opts; return () => { loads += 1; }; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const sessions = [{ session: 's-alpha', rules: ['Bash(echo "<img>")', 'Write(//r/a)', 'WebFetch(domain:docs.x.dev)'] }];
  const integrations = [
    { id: 'github', name: 'GitHub', ready: false, missing: "gh isn't logged in <img>", fix: { command: 'gh auth login <img>' }, waits: 'GitHub polling and PR reports wait on this.' },
    { id: 'codex', name: 'Codex', ready: true, detail: 'Installed and logged in <img>' },
    { id: 'linear', name: 'Linear', ready: false, missing: 'No Linear key set', keyButton: 'Add key', waits: null },
    { id: 'slack', name: 'Slack', ready: true, detail: 'Token set · Acme workspace, sending as love', keyButton: 'Change key', waits: null },
    { id: 'notifications', name: 'Notifications', ready: true, detail: 'Pushes on · 2 devices', devices: [
      { id: 'mine', kind: 'Mac', browser: 'Chrome', added: new Date(Date.now() - 2 * 3600_000).toISOString() },
      { id: 'other', kind: 'iPhone', browser: '', added: new Date(Date.now() - 5 * 60_000).toISOString() }] },
  ];
  const data = hubView({ now, st: status(now, DEFAULTS), integrations,
    sidebar: { pause: CALM_GATE, sites: [{ route: 'alpha', board: true }, { route: 'beta', board: true }], hub: { tone: 'wait', word: 'degraded', detail: '2 of 2 sites up · 1 link failing' }, notifications: {}, total: 0,
      usage: { claude: { at: now.toISOString(), five_hour: { used_percentage: 42, resets_at: t(20).toISOString(), state: 'live' }, seven_day: null }, codex: null } },
    rows: [{ route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'beta', title: 'Beta', state: 'up' }], remembered: new Map([['alpha', sessions]]), code: { running: 'abc', onDisk: 'abc' },
  });
  assert.deepEqual(data.groups[0].sites.map((s) => s.remembered), [sessions, []]);
  live.paint({ ...data, version: '0.4.2', remembered: [{ session: 's-alone', rules: ['WebSearch'] }] });
  assert.equal(root.querySelector('.hub-foot footer .version').textContent, 'kickflip.sh / 0.4.2');
  // Keep awake is a toggle row in Health under the machine row, and the Hub row no longer says Keeping awake.
  const healthGroup = root.querySelector('#keep-awake').parentNode;
  assert.deepEqual(healthGroup.querySelectorAll('.title').map((el) => el.textContent), ['Hub', 'Machine', 'Keep awake']);
  assert.match(healthGroup.querySelector('#keep-awake').textContent, /caffeinate -s.*only while it is on AC power/);
  assert.equal(healthGroup.querySelector('#keep-awake input.toggle').hasAttribute('checked'), false);
  live.paint({ ...data, awake: { on: true, unsupported: null } });
  assert.equal(root.querySelector('#keep-awake input.toggle').hasAttribute('checked'), true);
  assert.doesNotMatch(root.querySelector('.hub-status').textContent, /Keeping awake/);
  live.paint({ ...data, awake: { on: false, unsupported: 'macOS only · this host runs Linux' } });
  assert.equal(root.querySelector('input[name="keep_awake"]'), null);
  assert.match(root.querySelector('#keep-awake').textContent, /macOS only · this host runs Linux/);
  live.paint({ ...data, version: '0.4.2', remembered: [{ session: 's-alone', rules: ['WebSearch'] }] });
  const labels = root.querySelectorAll('.hub-status .label').map((el) => el.textContent);
  assert.equal(data.integrations, integrations);
  assert.deepEqual(labels.slice(0, 4), ['Usage', 'Health', 'Integrations', 'Boards']);
  const label = root.querySelectorAll('.label').find((el) => el.textContent === 'Integrations');
  const group = label.nextSibling;
  assert.deepEqual(group.querySelectorAll('.title').map((el) => el.textContent), ['GitHub', 'Codex', 'Linear', 'Slack', 'Notifications']);
  const [github, codex, linear, slack, notifications] = group.querySelectorAll('.row');
  assert.equal(github.querySelector('.st.wait').textContent, 'not ready');
  assert.match(github.textContent, /gh isn't logged in <img>/);
  assert.equal(github.querySelector('code').textContent, 'gh auth login <img>');
  assert.equal(github.querySelector('.rd-waits').textContent, integrations[0].waits);
  assert.match(github.querySelector('.icon').getAttribute('style'), /var\(--color-notice\)/);
  assert.equal(linear.querySelector('.rd-waits'), null);
  assert.equal(codex.querySelector('.st.ok').textContent, 'ready');
  assert.match(codex.textContent, /Installed and logged in <img>/);
  assert.match(codex.querySelector('.icon').getAttribute('style'), /var\(--color-quiet\)/);
  // Linear's and Slack's rows end in a button that opens their key modal, whichever state they are in.
  assert.equal(linear.querySelector('[data-settings-open="linear"]').textContent, 'Add key');
  assert.equal(slack.querySelector('[data-settings-open="slack"]').textContent, 'Change key');
  assert.equal(slack.querySelector('.rd-waits'), null);
  assert.equal(linear.querySelector('.rd-fix'), null);
  assert.equal(github.querySelector('[data-settings-open]'), null);
  const link = linear.querySelector('[data-settings-open="linear"]');
  listeners.find((l) => l.target === root.querySelector('.hub-status') && l.type === 'click').fn({ target: link });
  assert.deepEqual(plain(opened[0][0]), { hash: '#linear' });
  assert.equal(opened[0][1], link);
  assert.deepEqual(notifications.querySelectorAll('.rd-device').map((el) => el.textContent), ['Mac · Chrome · seen 2h ago · this device Remove', 'iPhone · seen 5m ago Remove']);
  assert.equal(codex.querySelector('.rd-device'), null);
  const posts = [];
  context.fetch = async (url, opts) => { posts.push([url, JSON.parse(opts.body)]); return { ok: true }; };
  listeners.find((l) => l.target === root.querySelector('.hub-status') && l.type === 'click').fn({ target: notifications.querySelectorAll('[data-forget-device]')[1] });
  assert.deepEqual(posts, [['/_hub/push/forget', { id: 'other' }]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  const health = root.querySelector('.hub-status .st.wait');
  assert.deepEqual([health.tagName, health.textContent, health.getAttribute('class')], ['SPAN', 'degraded', 'st wait']);
  assert.equal(root.querySelector('[data-jump]'), null);
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
  // docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md: while GitHub's limit holds, the row is red,
  // rate limited with its reset and the waits line, and no fix.
  live.paint({ ...data, version: '0.4.2', integrations: [{ ...integrations[0], fix: undefined, limited: true, missing: 'resets at 3:12pm' }, ...integrations.slice(1)] });
  const limited = root.querySelectorAll('.label').find((el) => el.textContent === 'Integrations').nextSibling.querySelector('.row');
  assert.equal(limited.querySelector('.st.down').textContent, 'rate limited');
  assert.equal(limited.querySelector('.st.wait'), null);
  assert.match(limited.textContent, /rate limited · resets at 3:12pm/);
  assert.equal(limited.querySelector('.rd-waits').textContent, integrations[0].waits);
  assert.match(limited.querySelector('.icon').getAttribute('style'), /var\(--color-danger\)/);
});

// docs/adr/2026-11-15-0730-an-integration-missing-a-permission-reads-degraded.md
test('an integration missing a permission reads amber degraded, and tapping the word opens a sheet with each missing permission and the one fix; none missing reads ready with no sheet', async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  let live;
  const listeners = [], opened = [];
  const context = vm.createContext({
    navigator: {}, localStorage: { getItem: () => null },
    BoardView: { page: (root, site, run) => run({ $: (s) => root.querySelector(s), atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { markup: () => '', create: () => ({ B: { openSettings: (...args) => opened.push(args) }, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI, ago: () => '5m ago' },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { device: () => ({ state: () => null }), forms: () => ({}), live: (B, opts) => { live = opts; return () => {}; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = context.AppViews.hub.markup();
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const fix = 'Add these scopes to the Slack app, reinstall it, paste the new token';
  const unheard = { scope: 'im:history', effect: "Review-thread replies aren't heard" };
  const unsearched = { scope: 'search:read', effect: "@kickflip in your DMs isn't found" };
  const slack = { id: 'slack', name: 'Slack', ready: true, detail: 'Token set · Acme workspace, sending as love', keyButton: 'Change key', waits: null };
  const data = hubView({ now, st: status(now, DEFAULTS), integrations: [],
    sidebar: { pause: CALM_GATE, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' }, notifications: {}, total: 0, usage: { claude: null, codex: null } }, rows: [] });
  const paint = (...integrations) => live.paint({ ...data, version: '0.4.2', integrations });
  const rows = () => root.querySelectorAll('.label').find((el) => el.textContent === 'Integrations').nextSibling.querySelectorAll('.row');
  const click = (target) => listeners.filter((l) => l.type === 'click' && l.target?.contains?.(target)).forEach((l) => l.fn({ target }));
  const sheet = root.querySelector('dialog.permissions-sheet');

  // None missing: green ready, nothing to tap.
  paint(slack);
  assert.equal(rows()[0].querySelector('.st.ok').textContent, 'ready');
  assert.equal(rows()[0].querySelector('[data-permissions]'), null);

  // One missing: amber degraded on an amber tile, the detail after it, and no scope sentence on the row.
  paint({ ...slack, permissions: { missing: [unheard], fix } });
  let row = rows()[0];
  const word = row.querySelector('button.st.wait[data-permissions="slack"]');
  assert.deepEqual([word.textContent, word.getAttribute('aria-haspopup')], ['degraded', 'dialog']);
  assert.equal(row.querySelector('.st.ok'), null);
  assert.match(row.querySelector('.sub').textContent, /^degraded · Token set · Acme workspace, sending as love$/);
  assert.match(row.querySelector('.icon').getAttribute('style'), /var\(--color-notice\)/);
  assert.doesNotMatch(row.textContent, /im:history/);
  assert.equal(row.querySelector('[data-settings-open="slack"]').textContent, 'Change key');
  assert.equal(sheet.open, false);
  click(word);
  assert.equal(sheet.open, true);
  assert.equal(sheet.querySelector('h2').textContent, 'Slack is missing permissions');
  assert.deepEqual(sheet.querySelectorAll('.mp-list li').map((li) => [li.querySelector('span').textContent, li.querySelector('code').textContent]), [["Review-thread replies aren't heard", 'im:history']]);
  assert.equal(sheet.querySelector('.mp-fix').textContent, fix);
  // Change key closes the sheet and opens Slack's key modal.
  const change = sheet.querySelector('[data-settings-open="slack"]');
  assert.equal(change.textContent, 'Change key');
  click(change);
  assert.equal(sheet.open, false);
  assert.deepEqual(plain(opened.at(-1)[0]), { hash: '#slack' });

  // Both missing: one line each, in order, then the one fix; ✕ closes it.
  paint({ ...slack, permissions: { missing: [unheard, unsearched], fix } });
  click(rows()[0].querySelector('[data-permissions]'));
  assert.deepEqual(sheet.querySelectorAll('.mp-list code').map((el) => el.textContent), ['im:history', 'search:read']);
  assert.equal(sheet.querySelectorAll('.mp-fix').length, 1);
  click(sheet.querySelector('[aria-label="Close sheet"]'));
  assert.equal(sheet.open, false);

  // Token refused stays red, with no degraded word.
  paint({ id: 'slack', name: 'Slack', ready: false, missing: 'Slack refused the token', keyButton: 'Change key', waits: null });
  assert.equal(rows()[0].querySelector('[data-permissions]'), null);

  // The same helper draws GitHub's and Linear's rows and sheets, escaped, under their own names and buttons.
  paint({ id: 'github', name: 'GitHub', ready: true, detail: 'gh logged in as love', permissions: { missing: [{ scope: 'read:org <img>', effect: 'Org repos <img> aren’t listed' }], fix: 'Run gh auth refresh' } },
    { id: 'linear', name: 'Linear', ready: true, detail: 'Key set · Work workspace', keyButton: 'Change key', permissions: { missing: [{ scope: 'write', effect: 'Issues aren’t created' }], fix: 'Make a key with write access' } });
  const [github, linear] = rows();
  assert.equal(github.querySelector('button.st.wait').textContent, 'degraded');
  click(github.querySelector('[data-permissions="github"]'));
  assert.equal(sheet.querySelector('h2').textContent, 'GitHub is missing permissions');
  assert.equal(sheet.querySelector('code').textContent, 'read:org <img>');
  assert.equal(sheet.querySelector('img'), null);
  assert.equal(sheet.querySelector('[data-settings-open]'), null);
  click(sheet.querySelector('[aria-label="Close sheet"]'));
  click(linear.querySelector('[data-permissions="linear"]'));
  assert.equal(sheet.querySelector('h2').textContent, 'Linear is missing permissions');
  assert.equal(sheet.querySelector('.mp-fix').textContent, 'Make a key with write access');
  assert.equal(sheet.querySelector('[data-settings-open="linear"]').textContent, 'Change key');
});

// docs/adr/2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md
test("the hub's runs-older-code notice jumps to Restart hub, which confirms, waits with its spinner through the hub's answer and restart, and reloads once the hub answers with its new code", async () => {
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
    BoardUI: { ...BOARD_UI },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { forms: () => ({}), live: (B, opts) => { live = opts; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  document.body = root;
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const view = (code) => hubView({ now, st: status(now, DEFAULTS), rows: [], code,
    sidebar: { pause: CALM_GATE, sites: [], hub: { tone: 'wait', word: 'degraded', detail: '0 of 0 sites up · runs older code than its files; restart it' }, notifications: {}, total: 0 } });
  const click = (target) => listeners.find((l) => l.target === root.querySelector('.hub-status') && l.type === 'click').fn({ target });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  live.paint(view({ running: 'abc', onDisk: 'abc' }));
  assert.equal(root.querySelector('[data-restart-hub]'), null);
  assert.equal(root.querySelector('[data-jump]'), null);
  assert.equal(root.querySelector('.hub-status .st.wait').tagName, 'SPAN', 'degraded for another reason is plain text');

  live.paint(view({ running: 'old', onDisk: 'abc' }));
  const notice = root.querySelector('.hub-status button.st');
  assert.equal(notice.textContent, 'degraded');
  assert.equal(root.querySelector('[data-jump]'), null);
  const button = root.querySelector('#restart-hub');
  assert.equal(button.textContent, 'Restart hub');
  assert.deepEqual(requests, []);

  confirmed = false;
  click(notice);
  await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Restart the hub\?$/);
  assert.deepEqual(requests, []);

  confirmed = true;
  click(root.querySelector('#restart-hub'));
  await settle();
  assert.deepEqual(requests, [['/_hub/restart-hub', 'POST', '{}']]);
  const waits = () => { const b = root.querySelector('#restart-hub'); return [b.textContent, b.hasAttribute('disabled'), b.getAttribute('aria-busy')]; };
  assert.deepEqual(waits(), ['Restart hub', true, 'true']);
  assert.equal(root.querySelector('.hub-status button.st').hasAttribute('disabled'), true);

  // A refusal says why, and the button comes back.
  answer(409, { error: 'The hub is already restarting.' }, 'old');
  await settle();
  assert.equal(root.querySelector('[role="alert"]').textContent, 'The hub is already restarting.');
  assert.deepEqual(waits(), ['Restart hub', false, null]);

  click(root.querySelector('#restart-hub'));
  await settle();
  answer(200, { restarting: true, command: 'launchctl kickstart -k gui/$(id -u)/local.claude.kickflip-hub' }, 'old');
  await settle();
  assert.deepEqual(waits(), ['Restart hub', true, 'true'], 'Restart hub keeps waiting while the hub is down');
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
  const hub = (codexShare, codex = USABLE) => plain(hubView({ now, st: status(now, DEFAULTS), rows: [], codexShare, codex,
    sidebar: { pause: CALM_GATE, sites: [], hub: {}, notifications: {}, total: 0, usage: { claude: reading, codex: codex.usable && codexShare !== 'off' ? reading : null } } }));
  const context = vm.createContext({
    URLSearchParams, document, navigator: {},
    FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI },
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
  const hub = (claudeModel, claude = reading) => plain(hubView({ now, st: status(now, DEFAULTS), rows: [], codexShare: 'off', codex: USABLE, claudeModel,
    sidebar: { pause: CALM_GATE, sites: [], hub: {}, notifications: {}, total: 0, usage: { claude, codex: null } } }));
  const context = vm.createContext({
    URLSearchParams, document, navigator: {},
    FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI },
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
    opus: 'Always Opus. Auto would give small tasks to Sonnet.',
    auto: 'Auto: small tasks get Sonnet, the rest get Opus.',
    sonnet: 'Always Sonnet. Auto would give large tasks to Opus.',
  };

  live.paint(hub('auto'));
  assert.equal(claude().querySelector('.u-head .title').textContent, 'Claude');
  assert.equal(claude().querySelector('.segments').getAttribute('aria-label'), 'Claude model');
  assert.equal(claude().querySelector('.segments').getAttribute('action'), '/_hub/settings/claude-model');
  assert.deepEqual(claude().querySelectorAll('.segments button').map((b) => b.textContent), ['Opus', 'Auto', 'Sonnet']);
  assert.match(claude().textContent, /^Claude.*OpusAutoSonnetAuto: small tasks get Sonnet, the rest get Opus\.5-hour42%/);
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
  const page = (n) => plain(hubView({ now, st: status(now, notify(DEFAULTS, n)), rows: [], sidebar: { pause: CALM_GATE, sites: [], hub: {}, notifications: {}, total: 0 } }));
  const context = vm.createContext({
    URLSearchParams, document, navigator: {},
    FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: (el, site, ctx) => { settingsCtx = ctx; return { B: { refreshSettings: () => settingsRefreshes++ }, mount() {}, unmount() {} }; } },
    BoardUI: { ...BOARD_UI },
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

  const weekend = plain(hubView({ now: t(12, 0, 17), st: status(t(12, 0, 17), notify(DEFAULTS, { weekends_off: true })), rows: [], sidebar: { pause: CALM_GATE, sites: [], hub: {}, notifications: {}, total: 0 } }));
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
  let gate = { pause_at: 90, state: 'paused', used: 91, window: 'five_hour', resets_at: new Date(Date.now() + 3600_000).toISOString(), machine: CALM_GATE.machine };
  const data = () => ({ integrations: [], pause: { ...gate }, usage: { claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: gate.resets_at, state: 'live' } } }, hub: {}, groups: [], awake: { on: false, unsupported: null }, update: { latest: null, auto: true, clone: false } });
  const context = vm.createContext({
    URLSearchParams, document, navigator: {}, FormData: class { *[Symbol.iterator]() {} },
    BoardView: { page: (root, site, run) => run({ root, $: (s) => root.querySelector(s), toast: (text) => toasts.push(text), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI }, PromptAnswers: { wire: () => ({ shows: () => true }) },
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

// docs/adr/2026-11-10-1140-tapping-the-hub-pages-version-checks-npm-now.md
test("a tap on the footer's version checks npm now and shows the answer beside it: checking…, then up to date, pulling, a failure or a clone's commit", async () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  let live;
  const listeners = [], requests = [], answers = [];
  const context = vm.createContext({
    navigator: {},
    setTimeout: (fn) => Promise.resolve().then(fn),
    BoardView: { page: (root, site, run) => run({ $: (s) => root.querySelector(s), alive: () => true, atUnmount() {}, on: (target, type, fn) => listeners.push({ target, type, fn }) }) },
    BoardDialogs: { confirm: async () => true },
    AppShell: { reload() {} },
    fetch: (url, init = {}) => { requests.push([url, init.method || 'GET', init.body]); return new Promise((resolve) => answers.push(resolve)); },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { forms: () => ({}), live: (B, opts) => { live = opts; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  document.body = root;
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  live.paint({ ...hubView({ now, st: status(now, DEFAULTS), rows: [], code: { running: 'abc', onDisk: 'abc' },
    sidebar: { pause: CALM_GATE, sites: [], hub: { tone: 'ok', word: 'ok', detail: '' }, notifications: {}, total: 0 } }), version: '0.7.7' });
  const tap = () => listeners.find((l) => l.target === root.querySelector('.hub-foot') && l.type === 'click').fn({ target: root.querySelector('[data-check-update]') });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const note = () => root.querySelector('.update-note')?.textContent ?? null;
  const reply = (status, body) => answers.shift()({ ok: status < 400, json: async () => body });

  assert.equal(root.querySelector('[data-check-update]').textContent, 'kickflip.sh / 0.7.7');
  assert.equal(root.querySelector('[data-auto-update]').hasAttribute('checked'), true);
  assert.equal(note(), null);
  const paintWith = (update) => live.paint({ ...hubView({ now, st: status(now, DEFAULTS), rows: [], code: { running: 'abc', onDisk: 'abc' },
    sidebar: { pause: CALM_GATE, sites: [], hub: { tone: 'ok', word: 'ok', detail: '' }, notifications: {}, total: 0 }, update }), version: '0.7.7' });
  paintWith({ latest: '0.7.8', auto: false, clone: false });
  assert.equal(root.querySelector('[data-check-update]').textContent, 'kickflip.sh / 0.7.7 > 0.7.8 (new)');
  assert.equal(root.querySelector('[data-auto-update]').hasAttribute('checked'), false);
  paintWith({ latest: null, auto: true, clone: true });
  assert.equal(root.querySelector('[data-auto-update]'), null);
  paintWith({ latest: null, auto: true, clone: false });
  tap();
  await settle();
  assert.deepEqual(requests, [['/_hub/check-update', 'POST', '{}']]);
  assert.equal(note(), 'checking…');
  tap();
  await settle();
  assert.equal(requests.length, 1, 'a tap while a check runs asks nothing more');
  reply(200, { state: 'same', latest: '0.7.7' });
  await settle();
  assert.equal(note(), 'up to date');
  for (const [out, text] of [
    [{ state: 'pulling', latest: '0.7.8' }, 'pulling 0.7.8…'],
    [{ state: 'failed', error: 'npm answered 503' }, 'check failed: npm answered 503'],
    [{ state: 'clone', commit: 'abc1234' }, 'abc1234 · pulls with main'],
  ]) {
    tap();
    await settle();
    reply(200, out);
    await settle();
    assert.equal(note(), text);
  }
  tap();
  await settle();
  reply(500, {});
  await settle();
  assert.equal(note(), 'could not check. Is the host awake?');
});

// docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md
test("the hub page's Routed section sits under Boards, drawn by the board's own New strip under a Routed head, with an empty state", () => {
  const document = {};
  const { Element } = miniDom(class {}, document);
  const root = new Element('div');
  let live;
  const strips = [];
  const context = vm.createContext({
    navigator: {}, localStorage: { getItem: () => null },
    BoardView: { page: (r, site, run) => run({ $: (s) => r.querySelector(s), alive: () => true, atUnmount() {}, on() {} }) },
    HubSettings: { create: () => ({ B: {}, mount() {}, unmount() {} }) },
    BoardUI: { ...BOARD_UI, newStrip: (entries, edits, opts) => { strips.push({ entries, opts }); return `<i class="strip">${entries.length}</i>`; } },
    PromptAnswers: { wire: () => ({ shows: () => true }) },
    HubKit: { forms: () => ({}), live: (B, opts) => { live = opts; } },
  });
  for (const file of ['ui-sidebar.js', 'ui-hub.js', 'view-hub.js']) vm.runInContext(fs.readFileSync(new URL(`../board/public/${file}`, import.meta.url), 'utf8'), context);
  root.innerHTML = '<main><div class="hub-status"></div><section class="hub-settings"></section><div class="hub-foot"></div></main>';
  document.body = root;
  context.AppViews.hub.create(root, '/_hub', {});
  const now = t(19);
  const row = { id: 'r1', at: now.toISOString(), text: 'checkout', via: 'slack', by: 'Maya', reason: 'shop', to: { route: 'alpha', ref: 'T-1', title: 'Checkout', href: '/alpha/#selectedCard=w%2FT-1' } };
  const view = (routed) => hubView({ now, st: status(now, DEFAULTS), routed,
    sidebar: { pause: CALM_GATE, sites: [{ route: 'alpha', board: true }], hub: { tone: 'ok', word: 'healthy', detail: '1 of 1 site up' }, notifications: {}, total: 0 },
    rows: [{ route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'page', title: 'Page', state: 'up' }], code: { running: 'abc', onDisk: 'abc' } });
  assert.deepEqual(plain(view([row]).routed), [row]);
  live.paint({ ...view([row]), version: '1' });
  const section = root.querySelector('section.new-strip.routed');
  assert.equal(section.getAttribute('aria-label'), 'Routed');
  const order = section.parentNode.children.filter((el) => el.tagName === 'H2' || el === section).map((el) => (el === section ? 'Routed' : el.textContent));
  assert.deepEqual(order.slice(-3), ['Boards', 'Routed', 'Pages'], 'it follows the Boards group');
  assert.deepEqual(plain(strips.at(-1).entries), [{ id: 'r1', routed: row }]);
  assert.equal(strips.at(-1).opts.label, 'Routed');
  live.paint({ ...view([]), version: '1' });
  assert.deepEqual(strips.at(-1).entries.length, 0);
  assert.match(strips.at(-1).opts.empty, /^Nothing routed yet\./);
});
