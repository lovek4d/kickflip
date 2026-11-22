import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { read, update, updateSync, settingsFile, readCodexShare, setCodexShare, readAutoUpdate, setAutoUpdate, readLandTests, setLandTests, MAX_LAND_TESTS, readBoardDefaults, setBoardDefault } from './hub-settings.mjs';
import { setPauseAt } from './usage-gate.mjs';
import { writeHubRules, readHubRules } from '../hub/rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = () => tempDir('hub-settings-');

test('read gives {} for a missing, broken or non-object file, and update keeps the keys it does not change', async () => {
  const h = home();
  assert.deepEqual(read(h), {});
  fs.mkdirSync(path.dirname(settingsFile(h)), { recursive: true });
  for (const bad of ['{', 'null', '[]', '"x"']) { fs.writeFileSync(settingsFile(h), bad); assert.deepEqual(read(h), {}); }
  await update(() => ({ rules: ['kept'], pauseAt: 80 }), h);
  await setAutoUpdate(false, h);
  assert.deepEqual(read(h), { rules: ['kept'], pauseAt: 80, autoUpdate: false });
  assert.equal(readAutoUpdate(h), false);
  await setAutoUpdate(true, h);
  assert.equal(readAutoUpdate(h), true);
});

test('an update that throws writes nothing and leaves no lock behind', async () => {
  const h = home();
  await update(() => ({ pauseAt: 70 }), h);
  await assert.rejects(update(() => { throw new Error('no'); }, h), { message: 'no' });
  assert.deepEqual(read(h), { pauseAt: 70 });
  assert.equal(fs.existsSync(`${settingsFile(h)}.lock`), false);
});

test('the setters refuse a bad value with a status and write nothing', async () => {
  const h = home();
  await assert.rejects(setLandTests('0', h), { status: 400 });
  await assert.rejects(setCodexShare('maybe', { usable: true }, h), { status: 400 });
  await assert.rejects(setCodexShare('always', { usable: false, words: 'No Codex.', fix: 'codex login' }, h), { status: 409 });
  assert.equal(fs.existsSync(settingsFile(h)), false);
  assert.equal(readLandTests(h), MAX_LAND_TESTS);
  assert.equal(await setLandTests('3', h), 3);
  assert.equal(readCodexShare({ usable: true }, h), 'auto');
});

// docs/adr/2026-11-22-0130-the-auto-settings-are-hub-defaults-a-board-can-override.md
test("Board defaults read off until settings.json says on, and a hub's Auto setting saves on or off for the four keys only", async () => {
  const h = home();
  assert.deepEqual(readBoardDefaults(h), { auto_build: false, auto_review: false, auto_merge: false, idle_notification: false });
  await setBoardDefault('auto_review', 'on', h);
  await setBoardDefault('auto_merge', 'off', h);
  assert.deepEqual(read(h).boardDefaults, { auto_review: true, auto_merge: false });
  assert.deepEqual(readBoardDefaults(h), { auto_build: false, auto_review: true, auto_merge: false, idle_notification: false });
  await assert.rejects(setBoardDefault('auto_review', 'yes', h), { status: 400, message: 'auto-review takes on or off' });
  await assert.rejects(setBoardDefault('prs', 'on', h), { status: 400, message: 'no board default "prs"' });
  assert.deepEqual(read(h).boardDefaults, { auto_review: true, auto_merge: false });
});

test('a pause-at and a hub rules edit made at once both survive, in this process and across processes', async () => {
  const h = home();
  const home0 = process.env.HOME;
  process.env.HOME = h;
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? setPauseAt(75, { home: h }) : writeHubRules([{ id: `r${i}`, text: 'x' }]))));
    assert.equal(read(h).pauseAt, 75);
    assert.equal(readHubRules().length, 1);
  } finally { process.env.HOME = home0; }

  const child = (code) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: h, KICKFLIP_LOCK_TIMEOUT_MS: '60000' }, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited ${c}`))));
  });
  const settings = JSON.stringify(path.join(here, 'hub-settings.mjs'));
  await Promise.all(Array.from({ length: 8 }, (_, i) => child(`
    import { update } from ${settings};
    for (let n = 0; n < 15; n++) await update((file) => ({ ...file, ['k${i}']: n }));`)));
  const file = read(h);
  for (let i = 0; i < 8; i++) assert.equal(file[`k${i}`], 14, `k${i} kept its last write`);
  assert.equal(file.pauseAt, 75);
});

test('updateSync writes before it returns and leaves no lock behind', async () => {
  const h = home();
  await update(() => ({ a: 1 }), h);
  updateSync((file) => ({ ...file, b: 2 }), h);
  assert.deepEqual(read(h), { a: 1, b: 2 });
  assert.equal(fs.existsSync(`${settingsFile(h)}.lock`), false);
  await update((file) => ({ ...file, c: 3 }), h);
  assert.deepEqual(read(h), { a: 1, b: 2, c: 3 });
});
