// An in-process hub for tests (hub.mjs startHub). Several hub modules (push, prompts, boards, live, router, sessions)
// read os.homedir() as they load, so this module sets HOME as it loads: a test file imports it before anything else,
// and its tests share that one scratch home. The home's bin holds stand-ins that fail for every tool the hub would
// otherwise run on the host (gh, tailscale, launchctl, claude, tmux, …), and a Restart hub or self-restart runs
// /usr/bin/true, never the host's hub service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

export const home = fs.realpathSync(tempDir('hub-test-'));
export const web = path.join(home, '.claude', 'kickflip');
export const bin = path.join(home, 'bin');
process.env.HOME = home;
for (const tool of ['gh', 'tailscale', 'launchctl', 'systemctl', 'codex', 'caffeinate', 'claude', 'tmux']) {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}
Object.assign(process.env, {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  KICKFLIP_CLAUDE: '/usr/bin/false',
  KICKFLIP_TMUX: '/usr/bin/false',
  KICKFLIP_TAILSCALE: path.join(bin, 'tailscale'),
  KICKFLIP_RESTART_CMD: JSON.stringify(['/usr/bin/true']),
});

export const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };

// A Mac with nothing running, so the busy gate never holds work.
export const idleMachine = () => ({ load: 0, cores: 8, pressure: 'normal' });

// Starts a hub on port 0 with no timers of its own (the test runs each pass) and an idle Mac, closed after the test.
// options go to startHub. → startHub's hub, with base, its URL, lines, what it has logged, and logged(pattern, n = 1),
// which resolves with the nth line, logged so far or next, that matches.
export async function inProcessHub(t, options = {}) {
  const { startHub } = await import('./hub.mjs');
  const lines = [];
  const waiters = new Set();
  const log = (...parts) => {
    const line = parts.join(' ');
    lines.push(line);
    for (const w of [...waiters]) if (w.pattern.test(line) && --w.left === 0) { waiters.delete(w); w.resolve(line); }
  };
  const logged = (pattern, n = 1) => {
    const seen = lines.filter((line) => pattern.test(line));
    return seen.length >= n ? Promise.resolve(seen[n - 1]) : new Promise((resolve) => waiters.add({ pattern, left: n - seen.length, resolve }));
  };
  const hub = await startHub({ ticks: false, readMachine: idleMachine, log, ...options });
  t.after(() => hub.close());
  return { ...hub, base: `http://127.0.0.1:${hub.port}`, lines, logged };
}

// A readiness signal for a real server the hub starts, such as board/server.mjs: put args before its script in the
// site's cmd, and up() resolves with the pid of the next of them that listens (each process signals its first listen).
// → {args, up()}
export async function serverSignals(t) {
  const { default: http } = await import('node:http');
  const ups = [];
  const waiting = [];
  const server = http.createServer((req, res) => {
    res.end();
    const pid = Number(new URL(req.url, 'http://x').searchParams.get('pid'));
    if (waiting.length) waiting.shift()(pid); else ups.push(pid);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const { port } = server.address();
  const preload = path.join(home, `listening-${port}.mjs`);
  write(preload, `import net from 'node:net';
const listen = net.Server.prototype.listen;
let signalled = false;
net.Server.prototype.listen = function (...args) {
  if (!signalled) { signalled = true; this.once('listening', () => fetch('http://127.0.0.1:${port}/up?pid=' + process.pid)); }
  return listen.apply(this, args);
};
`);
  return { args: ['--import', preload], up: () => (ups.length ? Promise.resolve(ups.shift()) : new Promise((resolve) => waiting.push(resolve))) };
}
