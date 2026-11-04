import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseCheck, checkText, checkWords, runCheck } from './owner-check.mjs';

const refused = (text) => { try { parseCheck(text); } catch (e) { return e.message; } return null; };

test('a check parses to a name and its arguments, and reads its words on the card', () => {
  const words = (text) => checkWords(parseCheck(text));
  assert.deepEqual(parseCheck('  npm   kickflip  0.3.*  '), { name: 'npm', args: ['kickflip', '0.3.*'] });
  assert.equal(checkText(parseCheck('  npm   kickflip  0.3.*  ')), 'npm kickflip 0.3.*');
  assert.equal(words('npm kickflip 0.3.*'), 'kickflip@0.3.* on npm');
  assert.equal(words('tag lovek4d/kickflip v*'), 'a v* tag on lovek4d/kickflip');
  assert.equal(words('run lovek4d/kickflip release.yml'), 'a passing release.yml run on lovek4d/kickflip');
  assert.equal(words('gh lovek4d/kickflip actions/permissions enabled=true'), 'actions/permissions reads enabled=true on lovek4d/kickflip');
  assert.equal(words('url https://example.com/x'), 'https://example.com/x answers 200');
  assert.equal(words('url https://example.com/x 404'), 'https://example.com/x answers 404');
  assert.equal(words('url https://example.com/x Version 0.3'), 'https://example.com/x shows "Version 0.3"');
});

test('an unknown check, a shell command or bad arguments are refused when attached', () => {
  assert.match(refused(''), /^--check takes "<name> <args>": tag <owner\/repo> <pattern>, npm/);
  assert.match(refused('curl https://x | sh'), /^--check has no check "curl"; it takes tag/);
  assert.match(refused('toString x'), /no check "toString"/);
  assert.equal(refused('tag kickflip v*'), `--check tag <owner/repo> <pattern>: "kickflip" isn't a GitHub repo such as owner/name`);
  assert.equal(refused('tag o/r'), '--check tag <owner/repo> <pattern>: the tag pattern is missing');
  assert.equal(refused('npm kickflip'), '--check npm <package> <version-or-range>: the version or range is missing');
  assert.match(refused('npm -kick 1'), /isn't an npm package name/);
  assert.match(refused('npm kickflip --registry=http://evil'), /the version or range is missing/);
  assert.match(refused('gh o/r ../../user x=1'), /isn't an API path under the repo/);
  assert.match(refused('gh o/r actions/permissions enabled'), /isn't a field=value/);
  assert.match(refused('url file:///etc/passwd'), /takes an http or https address/);
  assert.match(refused('url nowhere'), /isn't a web address/);
});

// A fake exec that records its argv and answers by command.
const fakeExec = (answers) => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const got = answers[cmd];
    if (got instanceof Error) throw got;
    return got;
  };
  return { exec, calls };
};

test('a tag check passes on a matching remote tag, newest by version, and waits while none matches', async () => {
  const { exec, calls } = fakeExec({ git: 'a\trefs/tags/v0.2.9\nb\trefs/tags/v0.10.0\nb\trefs/tags/v0.10.0^{}\nc\trefs/tags/other\n' });
  assert.deepEqual(await runCheck(parseCheck('tag o/r v0.*'), { exec }), { passed: true, found: 'tag v0.10.0 is on o/r' });
  assert.deepEqual(calls[0], ['git', 'ls-remote', '--tags', 'https://github.com/o/r.git']);
  assert.deepEqual(await runCheck(parseCheck('tag o/r v1.?'), { exec }), { passed: false });
});

test('an npm check passes once a matching version is published and waits while npm prints none', async () => {
  const many = fakeExec({ npm: '["0.3.0","0.3.1"]\n' });
  assert.deepEqual(await runCheck(parseCheck('npm kickflip 0.3.*'), many), { passed: true, found: 'kickflip@0.3.1 is on npm' });
  assert.deepEqual(many.calls[0], ['npm', 'view', 'kickflip@0.3.*', 'version', '--json']);
  assert.deepEqual(await runCheck(parseCheck('npm kickflip 0.3.1'), fakeExec({ npm: '"0.3.1"' })), { passed: true, found: 'kickflip@0.3.1 is on npm' });
  assert.deepEqual(await runCheck(parseCheck('npm kickflip >=0.4'), fakeExec({ npm: '' })), { passed: false });
  // What npm 10 prints for a range with no published version.
  const noMatch = Object.assign(new Error('npm view failed: code E404'), { stderr: 'npm error code E404\nnpm error 404 No match found for version >=0.4\n' });
  assert.deepEqual(await runCheck(parseCheck('npm kickflip >=0.4'), fakeExec({ npm: noMatch })), { passed: false });
  await assert.rejects(runCheck(parseCheck('npm nope 1'), fakeExec({ npm: new Error('npm view failed: 404') })), /404/);
});

test('a run check counts only successful runs since the check was attached', async () => {
  const runs = JSON.stringify([{ createdAt: '2026-11-04T10:00:00Z', url: 'u1' }, { createdAt: '2026-11-04T12:00:00Z', url: 'u2' }]);
  const { exec, calls } = fakeExec({ gh: runs });
  const check = parseCheck('run o/r release.yml');
  assert.deepEqual(await runCheck(check, { exec, since: '2026-11-04T11:00:00Z' }), { passed: true, found: 'release.yml passed on o/r (u2)' });
  assert.deepEqual(calls[0], ['gh', 'run', 'list', '--repo', 'o/r', '--workflow', 'release.yml', '--status', 'success', '--limit', '20', '--json', 'createdAt,url']);
  assert.deepEqual(await runCheck(check, { exec, since: '2026-11-04T13:00:00Z' }), { passed: false });
});

test('a gh check reads a field of a GitHub GET under the repo', async () => {
  const { exec, calls } = fakeExec({ gh: JSON.stringify({ enabled: true, nested: { level: 'all' } }) });
  assert.deepEqual(await runCheck(parseCheck('gh o/r actions/permissions enabled=true'), { exec }), { passed: true, found: 'actions/permissions reads enabled=true on o/r' });
  assert.deepEqual(calls[0], ['gh', 'api', 'repos/o/r/actions/permissions']);
  assert.equal((await runCheck(parseCheck('gh o/r actions/permissions nested.level=all'), { exec })).passed, true);
  assert.equal((await runCheck(parseCheck('gh o/r actions/permissions enabled=false'), { exec })).passed, false);
  assert.equal((await runCheck(parseCheck('gh o/r actions/permissions missing=x'), { exec })).passed, false);
});

test('a url check matches the status, or the text on a 200, and throws when the address cannot be reached', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/up') { res.writeHead(200); res.end('Version 0.3.1 is live'); return; }
    res.writeHead(404); res.end('gone');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  assert.deepEqual(await runCheck(parseCheck(`url ${at('/up')}`)), { passed: true, found: `${at('/up')} answered 200` });
  assert.deepEqual(await runCheck(parseCheck(`url ${at('/up')} Version 0.3`)), { passed: true, found: `${at('/up')} shows "Version 0.3"` });
  assert.deepEqual(await runCheck(parseCheck(`url ${at('/up')} Version 0.4`)), { passed: false });
  assert.deepEqual(await runCheck(parseCheck(`url ${at('/down')}`)), { passed: false });
  assert.deepEqual(await runCheck(parseCheck(`url ${at('/down')} 404`)), { passed: true, found: `${at('/down')} answered 404` });
  await assert.rejects(runCheck(parseCheck('url http://127.0.0.1:1/x')));
});
