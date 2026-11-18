// docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md
import { home } from '../shared/scratch-home.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBoard } from '../shared/test-helpers.mjs';
import { SIGN_IN_COOKIE, makeSignInLink, redeemSignIn, signedIn } from '../shared/owner-sign-in.mjs';

let base, cookie;
const site = path.join(home, 'site');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const SIGN_IN = { error: 'Sign in first: run kickflip sign-in on the hub’s Mac and open the link it prints.' };

before(async () => {
  write(path.join(site, 'board.json'), { title: 'T', items: 'data/items.json', slug: 't' });
  write(path.join(site, 'data', 'items.json'), { items: [{ id: 'A1', title: 'feat: one' }] });
  write(path.join(site, 'data', 'owner.json'), { items: [] });
  write(path.join(site, 'public', 'visual.html'), '<html><body>A visual</body></html>');
  write(path.join(site, 'public', 'prototypes', 'p', 'A.js'), 'export function render() {}');
  // eslint-disable-next-line no-undef
  process.env.KICKFLIP_CLAUDE = 'true';
  cookie = `${SIGN_IN_COOKIE}=${await redeemSignIn(await makeSignInLink({ home }), { home })}`;
});

const start = async (t) => {
  const board = await startBoard(t, { site, signedIn: (req) => signedIn(req, home) });
  await board.settled();
  base = board.base;
  return board;
};
const post = (body, headers = {}) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test("an owner's tap straight to the board's port needs the sign-in cookie; a process's own events don't", async (t) => {
  await start(t);
  for (const body of [
    { kind: 'script-run', key: 't/A1', id: 's1', sha: 'x' }, { kind: 'script-decline', key: 't/A1', id: 's1' },
    { kind: 'card-done', key: 't/A1' }, { kind: 'card-merge', key: 't/A1' }, { kind: 'card-build', key: 't/A1' },
    { kind: 'owner-answer', id: 'q1', choice: 'A' }, { kind: 'owner-answers', answers: [] }, { kind: 'review-answer', pr: 1, answer: 'post' },
    { kind: 'reviewers', add: [] }, { kind: 'item-message', key: 't/A1', text: 'go', intent: 'build' }, { kind: 'prototype-request', key: 't/A1' },
  ]) {
    const answer = await post(body);
    assert.deepEqual([answer.status, await answer.json()], [401, SIGN_IN], body.kind);
  }
  const ask = await post({ kind: 'ask', text: 'From the CLI' });
  assert.equal(ask.status, 200, 'an agent files an ask');
  assert.equal((await post({ kind: 'builder-ask', key: 't/A1', text: 'Which?' })).status, 200);
  // A browser, or a request tailscale serve forwarded, gets no event in without the cookie.
  assert.equal((await post({ kind: 'ask', text: 'x' }, { origin: base, 'sec-fetch-site': 'same-origin' })).status, 401);
  assert.equal((await post({ kind: 'ask', text: 'x' }, { 'x-forwarded-for': '100.70.1.2' })).status, 401);
  // With the cookie, an owner tap reaches the board, which judges it as before.
  const done = await post({ kind: 'card-hold', key: 't/A1', hold: true, for: '1h' }, { cookie });
  assert.equal(done.status, 200, await done.text());
});

test("the board's reads and pages need the sign-in; the agent paths and the app's code and preview files don't", async (t) => {
  await start(t);
  for (const p of ['/api/board', '/api/thread?key=t%2FA1', '/api/notes?all=1', '/_claude/events', '/uploads/x.png', '/', '/settings.html', '/visual.html']) {
    const answer = await fetch(base + p, { headers: { accept: 'text/html', 'sec-fetch-site': 'same-origin' } });
    assert.equal(answer.status, 401, p);
    assert.match(await answer.text(), /Sign in to open this kickflip\./, p);
  }
  assert.equal((await fetch(`${base}/api/board`)).status, 401, 'nor from a process on this host');
  assert.equal((await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-filename': 'a.png', 'content-type': 'image/png' }, body: 'x' })).status, 401);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  for (const p of ['/_claude/health', '/_claude/needs', '/api/working']) assert.equal((await fetch(base + p)).status, 200, p);
  // A sandboxed preview, an opaque origin, loads these with no cookie.
  const opaque = { origin: 'null', 'sec-fetch-site': 'cross-site' };
  for (const p of ['/ui.js', '/prototype-kit.js', '/colors.css', '/prototypes/p/A.js']) assert.equal((await fetch(base + p, { headers: opaque })).status, 200, p);
  for (const p of ['/api/board', '/', '/visual.html']) assert.equal((await fetch(base + p, { headers: { cookie } })).status, 200, p);
});
