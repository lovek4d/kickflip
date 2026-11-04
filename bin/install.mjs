import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILLS_SOURCE, addArgv, addCommand, missingSkills } from '../shared/skills.mjs';
import { cloneRoot as runningClone } from '../shared/repos.mjs';
import { hubService, runCommand } from '../shared/service.mjs';

// Homebrew's node link survives `brew upgrade`, which removes the versioned folder process.execPath names.
export const nodeBin = () => (fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath);
// The watcher a site's owning session runs as a background task (bin/wait-events.mjs).
export const watcherCommand = (route, session, root = runningClone()) => `${nodeBin()} ${path.join(root, 'bin', 'wait-events.mjs')} ${route} ${session}`;

export function storedPath(realPath, { home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  if (typeof realPath !== 'string' || !path.isAbsolute(realPath)) return realPath;
  const relative = path.relative(cloneRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return realPath;
  // A worktree or a scratch HOME has no link to this clone; naming the link there would store a dangling path or another checkout's code.
  const link = path.resolve(skillsDir, 'kickflip');
  let linked = false;
  try { linked = fs.realpathSync(link) === fs.realpathSync(cloneRoot); } catch {}
  return linked ? path.join(link, relative) : realPath;
}

export function inspectLinks({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  const root = fs.realpathSync(cloneRoot);
  const links = [['kickflip', root], ['kickflip-hooks', path.join(root, 'hooks-plugin')]].map(([name, source]) => {
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${source}`);
    const target = name === 'kickflip' ? source : path.resolve(skillsDir, 'kickflip', 'hooks-plugin');
    const link = path.resolve(skillsDir, name);
    const existing = fs.lstatSync(link, { throwIfNoEntry: false });
    let refusal;
    if (existing) {
      let real;
      try { real = fs.realpathSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing.isSymbolicLink()) {
        if (real !== fs.realpathSync(source)) refusal = `refusing to replace link ${link} -> ${fs.readlinkSync(link)}; remove that link explicitly, then rerun kickflip doctor --fix`;
      } else if (!existing.isDirectory() || real !== fs.realpathSync(source)) {
        refusal = `refusing to replace real path ${link}; move it aside explicitly, then rerun kickflip doctor --fix`;
      }
    }
    return { link, target, created: !existing, ...(refusal ? { refusal } : {}) };
  });
  const source = path.join(root, 'bin', 'statusline.mjs');
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`not a file: ${source}`);
  const statusline = path.join(home, '.claude', 'statusline.sh');
  const target = path.resolve(skillsDir, 'kickflip', 'bin', 'statusline.mjs');
  const existing = fs.lstatSync(statusline, { throwIfNoEntry: false });
  let replace = false;
  let refusal;
  if (existing) {
    if (!existing.isSymbolicLink()) refusal = `refusing to replace real path ${statusline}; move it aside explicitly, then rerun kickflip doctor --fix`;
    else {
      let real;
      try { real = fs.realpathSync(statusline); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // A site's status-line prototype stands in only until kickflip's own is installed.
      const sites = path.join(home, '.claude', 'kickflip', 'sites');
      let sitesReal = sites;
      try { sitesReal = fs.realpathSync(sites); } catch {}
      const prototype = Boolean(real) && [sites, sitesReal].some((dir) => real.startsWith(dir + path.sep));
      if (real && real !== fs.realpathSync(source) && !prototype) refusal = `refusing to replace link ${statusline} -> ${fs.readlinkSync(statusline)}; remove that link explicitly, then rerun kickflip doctor --fix`;
      replace = prototype || path.resolve(path.dirname(statusline), fs.readlinkSync(statusline)) !== target || !real;
    }
  }
  links.push({ link: statusline, target, created: !existing, ...(replace ? { replaced: true } : {}), ...(refusal ? { refusal } : {}) });
  return links;
}

export function installLinks({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone(), dryRun = false } = {}) {
  const links = inspectLinks({ home, skillsDir, cloneRoot });
  const refused = links.find((entry) => entry.refusal);
  if (refused) throw new Error(refused.refusal);
  if (dryRun) return links;
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const { link, target, created, replaced } of links) {
    if (replaced) fs.unlinkSync(link);
    if (created || replaced) fs.symlinkSync(target, link, link === path.join(home, '.claude', 'statusline.sh') ? 'file' : 'dir');
  }
  return links;
}

export function ownsStatusLine(statusLine, home = os.homedir()) {
  const command = path.join(home, '.claude', 'statusline.sh');
  const ownCommands = [command, `"${command}"`, `'${command.replaceAll("'", "'\\''")}'`, '~/.claude/statusline.sh', '$HOME/.claude/statusline.sh', '"$HOME/.claude/statusline.sh"', '${HOME}/.claude/statusline.sh', '"${HOME}/.claude/statusline.sh"'];
  return statusLine?.type === 'command' && ownCommands.includes(statusLine.command);
}

// The Stop hook that keeps a board's session from ending a turn with no live watcher (hooks-plugin/hooks/watcher-stop.mjs).
export const WATCHER_STOP = 'node "$HOME/.claude/skills/kickflip/hooks-plugin/hooks/watcher-stop.mjs"';
export const hasWatcherStop = (settings) => (Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : [])
  .some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => hook?.type === 'command' && /\/hooks-plugin\/hooks\/watcher-stop\.mjs\b/.test(hook.command)));

export async function hubStatus({ port = Number(process.env.KICKFLIP_HUB_PORT || 4500), fetch = globalThis.fetch } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_hub/status.json`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const hub = await r.json();
    return Array.isArray(hub?.sites) ? hub : null;
  } catch { return null; }
}

export function tailscaleRoot(config) {
  const handlers = Object.entries(config?.Web || {}).filter(([host]) => !/:\d+$/.test(host) || host.endsWith(':443')).flatMap(([, web]) => Object.entries(web.Handlers || {}));
  return { root: handlers.find(([route]) => route === '/')?.[1]?.Proxy || null, paths: [...new Set(handlers.map(([route]) => route))] };
}

// The HTTPS address the phone opens: tailscale / is the hub, so the hub is at https://<host>/ and a site at
// https://<host>/<route>/, as kickflip.mjs siteUrl builds it. Throws the one-line reason when Tailscale isn't running
// or the tailnet has no HTTPS certificate for this host.
export function tailnetUrl(route, { run = runCommand } = {}) {
  const r = run('tailscale', ['status', '--json']);
  let status = null;
  try { status = r.status === 0 ? JSON.parse(r.stdout) : null; } catch {}
  if (status?.BackendState !== 'Running') throw new Error("Tailscale isn't running on this host; start it, or run tailscale up");
  const host = status.Self?.DNSName?.replace(/\.$/, '') || '';
  if (!host || !status.CertDomains?.includes(host)) throw new Error("HTTPS isn't on for this tailnet; turn on HTTPS Certificates on the DNS page of the Tailscale admin console");
  return `https://${host}/${route ? route + '/' : ''}`;
}

export const tailscaleInstallHint =(platform = process.platform) => platform === 'darwin'
  ? 'brew install --cask tailscale' : 'curl -fsSL https://tailscale.com/install.sh | sh';

export async function tailscaleState({ run = runCommand, platform = process.platform, uid = process.getuid(), username = os.userInfo().username, port = Number(process.env.KICKFLIP_HUB_PORT || 4500) } = {}) {
  const execute = async (args) => {
    try { return await run('tailscale', args); } catch (e) { return { status: 1, error: e.message }; }
  };
  const json = (r) => { try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  const version = await execute(['version']);
  const installed = version.status === 0;
  const status = installed ? json(await execute(['status', '--json'])) : null;
  const signedIn = status?.BackendState === 'Running';
  const dns = status?.Self?.DNSName?.replace(/\.$/, '') || '';
  const operatorChecked = installed && platform === 'linux' && uid !== 0;
  const operator = operatorChecked ? json(await execute(['debug', 'prefs']))?.OperatorUser : null;
  const serveConfig = installed ? json(await execute(['serve', 'status', '--json'])) : null;
  const serve = tailscaleRoot(serveConfig);
  let pointsAtHub = false;
  try {
    const url = new URL(serve.root);
    pointsAtHub = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === port && url.pathname === '/' && !url.search && !url.hash;
  } catch {}
  const entry = (item, ok, detail, fix, state = 'yours') => ({ item, state: ok ? 'ok' : state, detail, fix: ok ? null : fix });
  const prereqs = [
    entry('Tailscale', installed, installed ? (version.stdout || 'installed').trim().split('\n')[0] : 'not on this session’s PATH', tailscaleInstallHint(platform)),
    entry('Tailscale signed in', signedIn, signedIn ? `signed in${dns ? ' as ' + dns : ''}` : installed ? 'not connected' : 'needs Tailscale', 'tailscale up'),
  ];
  if (operatorChecked) prereqs.push(entry('Tailscale operator', operator === username, operator === username ? username : `${operator || 'none'} (expected ${username})`, 'sudo tailscale set --operator=$USER'));
  const mounts = serve.paths.filter((route) => route !== '/');
  const root = entry('tailscale /', pointsAtHub, `${serve.root || 'nothing'}${pointsAtHub ? '' : ` (expected the hub on ${port})`}${mounts.length ? '; other mounts: ' + mounts.join(', ') : ''}`, signedIn ? 'kickflip doctor --fix' : installed ? 'tailscale up' : tailscaleInstallHint(platform), signedIn ? 'fixable' : 'yours');
  return { installed, signedIn, dns, operatorChecked, operator, username, pointsAtHub, prereqs, root, serveConfig };
}

export async function runInstall({ home = os.homedir(), cloneRoot = runningClone(), port = Number(process.env.KICKFLIP_HUB_PORT || 4500), uid = process.getuid(), env = process.env, run = runCommand, platform = process.platform, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), fetch = globalThis.fetch, dryRun = false, log = console.log } = {}) {
  const state = path.join(home, '.claude', 'kickflip');
  const service = hubService({ platform, home, uid, env, run });
  if (dryRun) {
    try {
      for (const { link, target, created, replaced } of installLinks({ home, cloneRoot, dryRun })) log(`would ${created || replaced ? 'link' : 'check'} ${link} -> ${target}`);
    } catch (e) { log(`would refuse: ${e.message}`); }
    log(`would merge statusLine and the watcher Stop hook, turn on autoCompactEnabled and remove stale hooks in ${path.join(home, '.claude', 'settings.json')}`);
    const missing = missingSkills(home);
    if (missing.length) log(`would add ${missing.join(', ')} from ${SKILLS_SOURCE} with ${addCommand(missing)}`);
    for (const note of await service.install(null, { wait, dryRun })) log(note);
    log(`would map tailscale / to the hub on ${port} and remove old site mounts`);
    return;
  }
  for (const { link, target, created, replaced } of installLinks({ home, cloneRoot })) log(`${created || replaced ? 'linked' : 'checked'} ${link} -> ${target}`);
  for (const note of installClaudeSettings({ home })) log(note);
  const missing = missingSkills(home);
  if (missing.length) {
    const added = run('npx', addArgv(missing), { env, timeout: 300_000 });
    log(added.status === 0 ? `added ${missing.join(', ')} from ${SKILLS_SOURCE}` : `could not add ${missing.join(', ')} from ${SKILLS_SOURCE}: ${added.error}; run ${addCommand(missing)}`);
  }
  const node = nodeBin();
  const entry = storedPath(path.join(cloneRoot, 'hub', 'hub.mjs'), { home, cloneRoot });
  fs.mkdirSync(state, { recursive: true });
  const hubLog = path.join(state, 'hub.log');
  const definition = service.definition({ node, entry, state, port, log: hubLog });
  for (const note of await service.install(definition, { wait })) log(note);
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await wait(300);
    up = Boolean(await hubStatus({ port, fetch }));
  }
  if (!up) throw new Error('hub did not start; see ' + hubLog);
  const mapped = run('tailscale', ['serve', '--bg', String(port)], { env });
  if (mapped.status !== 0) throw new Error(mapped.error || 'tailscale serve failed');
  const served = run('tailscale', ['serve', 'status', '--json'], { env });
  let config;
  try { config = JSON.parse(served.stdout); } catch { return; }
  let sites = {};
  try { sites = JSON.parse(fs.readFileSync(path.join(state, 'manifest.json'), 'utf8')).sites || {}; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const route of tailscaleRoot(config).paths) {
    if (route !== '/' && Object.hasOwn(sites, route.replace(/^\//, '').replace(/\/$/, ''))) run('tailscale', ['serve', '--https=443', '--set-path=' + route, 'off'], { env });
  }
}

export function installClaudeSettings({ home = os.homedir() } = {}) {
  const file = path.join(home, '.claude', 'settings.json');
  let settings = {};
  let mode = 0o600;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    mode = fs.statSync(file).mode;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`not a settings object: ${file}`);
  const notes = [];
  let changed = false;
  const command = path.join(home, '.claude', 'statusline.sh');
  if (!Object.hasOwn(settings, 'statusLine')) {
    // statusLine.command runs in a shell; quote homes containing shell metacharacters.
    const shellCommand = /^[\w/.-]+$/.test(command) ? command : `'${command.replaceAll("'", "'\\''")}'`;
    settings.statusLine = { type: 'command', command: shellCommand };
    changed = true;
    notes.push(`set statusLine in ${file} -> ${shellCommand}`);
  } else {
    if (!ownsStatusLine(settings.statusLine, home)) notes.push(`kept existing statusLine in ${file}; it points elsewhere`);
  }
  if (!hasWatcherStop(settings)) {
    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    settings.hooks = { ...hooks, Stop: [...(Array.isArray(hooks.Stop) ? hooks.Stop : []), { hooks: [{ type: 'command', command: WATCHER_STOP }] }] };
    changed = true;
    notes.push(`added the watcher Stop hook to ${file} -> ${WATCHER_STOP}`);
  }
  // A board session that fills its context stops answering until it compacts (docs/adr/2026-11-03-1823-a-board-session-compacts-before-its-context-fills.md).
  if (settings.autoCompactEnabled !== true) {
    settings.autoCompactEnabled = true;
    changed = true;
    notes.push(`turned on autoCompactEnabled in ${file}`);
  }
  const missing = path.join(home, '.claude', 'hooks', 'no-paths.py');
  if (!fs.existsSync(missing) && settings.hooks && typeof settings.hooks === 'object') {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const scripts = [missing, '~/.claude/hooks/no-paths.py', '$HOME/.claude/hooks/no-paths.py', '${HOME}/.claude/hooks/no-paths.py'].map(escape).join('|');
    // Match an executed script (directly or through Python), not a path mentioned in echo or an argument to another hook.
    const stale = new RegExp(`^\\s*(?:exec\\s+)?(?:(?:/usr/bin/env\\s+)?(?:[^\\s]+/)?python(?:\\d+(?:\\.\\d+)*)?(?:\\s+-[^\\s]+)*\\s+)?(?:"(?:${scripts})"|'(?:${scripts})'|(?:${scripts}))(?=$|\\s)`);
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      settings.hooks[event] = groups.flatMap((group) => {
        if (!Array.isArray(group?.hooks)) return [group];
        const hooks = group.hooks.filter((hook) => {
          if (hook?.type !== 'command' || typeof hook.command !== 'string' || !stale.test(hook.command)) return true;
          notes.push(`removed stale hook ${event}: ${hook.command}`);
          changed = true;
          return false;
        });
        if (hooks.length === group.hooks.length) return [group];
        return hooks.length ? [{ ...group, hooks }] : [];
      });
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode, flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return notes;
}

export function uninstallStatusLine({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  const link = path.join(home, '.claude', 'statusline.sh');
  if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
  let owned = target === path.resolve(skillsDir, 'kickflip', 'bin', 'statusline.mjs');
  try { owned ||= fs.realpathSync(link) === fs.realpathSync(path.join(cloneRoot, 'bin', 'statusline.mjs')); } catch {}
  if (!owned) return false;
  fs.unlinkSync(link);
  return true;
}
