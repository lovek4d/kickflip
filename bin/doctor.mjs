import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneRoot as runningClone } from '../shared/repos.mjs';
import { inspectLinks, ownsStatusLine, hubStatus, tailscaleRoot, runCommand, runInstall, LOGIN_LABEL } from './install.mjs';

const FIX = 'kickflip doctor --fix';
const MARKS = { ok: 'ok', fixable: 'fixable', yours: 'yours', optional: 'optional', note: 'note' };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// → [{group: prereqs|setup|hub, item, state, detail, fix}]. state is ok; fixable, which `doctor --fix` sets up; yours,
// which only the person can fix with the fix command; optional, yours but not needed for the hub; or note, which the
// hub handles itself. Reads only: runs the read commands through run(command, argv, {env}) and asks the hub on port.
export async function doctorReport({ home = os.homedir(), cloneRoot = runningClone(), port = Number(process.env.KICKFLIP_HUB_PORT || 4500), uid = process.getuid(), env = process.env, run = runCommand, fetch = globalThis.fetch } = {}) {
  const items = [];
  let group;
  const add = (item, state, detail, fix = null) => items.push({ group, item, state, detail, fix: state === 'ok' || state === 'note' ? null : fix });
  const execute = (command, argv) => {
    try { return run(command, argv, { env }); } catch (e) { return { status: 1, error: e.message }; }
  };
  const json = (result) => { try { return result.status === 0 ? JSON.parse(result.stdout) : null; } catch { return null; } };
  const installed = (item, command, argv, fix, missing = 'not on this session’s PATH') => {
    const r = execute(command, argv);
    const ok = r.status === 0;
    add(item, ok ? 'ok' : 'yours', ok ? (r.stdout || 'installed').trim().split('\n')[0] : missing, fix);
    return ok;
  };

  group = 'prereqs';
  installed('git', 'git', ['--version'], 'xcode-select --install');
  installed('node on Claude’s PATH', 'node', ['--version'], `add ${quote(path.dirname(process.execPath))} to PATH in your shell profile, then restart Claude Code`, `not on this session’s PATH (${env.PATH || 'empty'})`);
  const gh = installed('gh', 'gh', ['--version'], 'brew install gh');
  const ghAuth = gh && execute('gh', ['auth', 'status']).status === 0;
  add('gh signed in', ghAuth ? 'ok' : 'yours', ghAuth ? 'signed in' : gh ? 'not signed in' : 'needs gh', 'gh auth login');
  const ts = installed('Tailscale', 'tailscale', ['version'], 'brew install --cask tailscale');
  const tsStatus = ts ? json(execute('tailscale', ['status', '--json'])) : null;
  const signedIn = tsStatus?.BackendState === 'Running';
  add('Tailscale signed in', signedIn ? 'ok' : 'yours', signedIn ? `signed in${tsStatus.Self?.DNSName ? ' as ' + tsStatus.Self.DNSName.replace(/\.$/, '') : ''}` : ts ? 'not connected' : 'needs Tailscale', 'tailscale up');
  const codex = fs.existsSync(path.join(home, '.codex', 'auth.json'));
  add('Codex login', codex ? 'ok' : 'optional', codex ? 'signed in' : 'not signed in; Codex builds and reviews need it', 'codex login');

  group = 'setup';
  const linkItems = ['kickflip skill link', 'kickflip-hooks link', '~/.claude/statusline.sh'];
  for (const [i, entry] of inspectLinks({ home, cloneRoot }).entries()) {
    if (entry.refusal) {
      const stat = fs.lstatSync(entry.link);
      add(linkItems[i], 'yours', stat.isSymbolicLink() ? `links to ${fs.readlinkSync(entry.link)}, not kickflip` : `a real ${stat.isDirectory() ? 'folder' : 'file'}, not kickflip’s link`,
        `${stat.isSymbolicLink() ? `rm ${quote(entry.link)}` : `mv ${quote(entry.link)} ${quote(entry.link + '.backup')}`} && ${FIX}`);
    } else add(linkItems[i], entry.created || entry.replaced ? 'fixable' : 'ok', `${entry.created ? 'missing' : entry.replaced ? 'needs relinking' : 'linked'} -> ${entry.target}`, FIX);
  }
  const settingsFile = path.join(home, '.claude', 'settings.json');
  let settings = {};
  let settingsError;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a settings object');
  } catch (e) { if (e.code !== 'ENOENT') settingsError = e.message; }
  const statusLine = 'settings.json statusLine';
  if (settingsError) add(statusLine, 'yours', `unreadable: ${settingsError}`, `repair the JSON in ${quote(settingsFile)}, then ${FIX}`);
  else if (!Object.hasOwn(settings, 'statusLine')) add(statusLine, 'fixable', 'missing', FIX);
  else if (ownsStatusLine(settings.statusLine, home)) add(statusLine, 'ok', 'runs ~/.claude/statusline.sh');
  else add(statusLine, 'yours', 'another tool’s status line is selected', `remove statusLine from ${quote(settingsFile)}, then ${FIX}`);
  const plist = path.join(home, 'Library', 'LaunchAgents', LOGIN_LABEL + '.plist');
  const login = execute('launchctl', ['print', `gui/${uid}/${LOGIN_LABEL}`]);
  const running = fs.existsSync(plist) && login.status === 0 && /\bstate = running\b/.test(login.stdout || '');
  add('hub login item', running ? 'ok' : 'fixable', running ? 'running' : fs.existsSync(plist) ? 'not running' : 'not installed', FIX);

  group = 'hub';
  const hub = await hubStatus({ port, fetch });
  add('hub', hub ? 'ok' : 'fixable', `${hub ? 'running' : 'not running'} on 127.0.0.1:${port}`, FIX);
  const serve = ts ? tailscaleRoot(json(execute('tailscale', ['serve', 'status', '--json']))) : { root: null, paths: [] };
  let pointsAtHub = false;
  try {
    const url = new URL(serve.root);
    pointsAtHub = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === port && url.pathname === '/' && !url.search && !url.hash;
  } catch {}
  const mounts = serve.paths.filter((route) => route !== '/');
  // doctor --fix maps / with `tailscale serve`, which needs Tailscale signed in first.
  add('tailscale /', pointsAtHub ? 'ok' : signedIn ? 'fixable' : 'yours', `${serve.root || 'nothing'}${pointsAtHub ? '' : ` (expected the hub on ${port})`}${mounts.length ? '; other mounts: ' + mounts.join(', ') : ''}`, signedIn ? FIX : ts ? 'tailscale up' : 'brew install --cask tailscale');

  let sites = hub?.sites;
  if (!sites) {
    const file = path.join(home, '.claude', 'kickflip', 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      sites = Object.entries(manifest.sites || {}).map(([route, site]) => ({ ...site, route, state: 'hub not running' }));
    } catch (e) {
      if (e.code !== 'ENOENT') add('site manifest', 'yours', e.message, `repair the JSON in ${quote(file)}`);
      sites = [];
    }
  }
  if (!sites.length) add('sites', 'ok', 'none');
  for (const site of sites) {
    const where = site.port ? `port ${site.port}` : `files ${site.dir}`;
    const detail = `${site.state}  ${where}  owner ${site.owner?.label || site.owner?.session || '-'}  ${site.title || ''}`.trimEnd();
    if (site.state === 'up') add('/' + site.route, 'ok', detail);
    else if (!hub) add('/' + site.route, 'fixable', detail, FIX);
    else if (site.serves === 'port') add('/' + site.route, 'note', `${detail}; its session runs this server, not the hub`);
    else if (site.serves === 'files') add('/' + site.route, 'note', `${detail}; its folder is missing`);
    else add('/' + site.route, 'note', `${detail}; the hub restarts it, see kickflip logs ${site.route}`);
  }
  return items;
}

export function doctorLines(items) {
  const width = Math.max(...Object.values(MARKS).map((mark) => mark.length));
  return items.flatMap((entry) => [`${MARKS[entry.state].padEnd(width)} ${entry.item}: ${entry.detail}`, ...(entry.fix ? [`${' '.repeat(width + 1)}→ ${entry.fix}`] : [])]);
}

export async function runDoctor({ fix = false, dryRun = false, json = false, write = console.log, error = console.error, install = runInstall, ...options } = {}) {
  let failed = false;
  if (fix) {
    try { await install({ ...options, dryRun, log: json ? error : write }); }
    catch (e) { failed = true; error('kickflip: ' + e.message); }
    if (dryRun) return { items: [], exitCode: failed ? 1 : 0 };
  }
  const items = await doctorReport(options);
  write(json ? JSON.stringify({ items }, null, 2) : doctorLines(items).join('\n'));
  return { items, exitCode: failed || items.some((entry) => entry.state === 'fixable' || entry.state === 'yours') ? 1 : 0 };
}
