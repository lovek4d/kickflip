import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTryPort } from '../hub/try.mjs';
import { githubGitArgv, gitReachFault } from '../hub/repos.mjs';
import { buildsLocally, isBoardSite } from '../hub/boards.mjs';
import { cloneRoot as runningClone, reposDir } from '../shared/repos.mjs';
import { codexStatus } from '../shared/codex.mjs';
import { REVIEW_SKILLS, SKILLS_SOURCE, addCommand, skillsState, updateCommand } from '../shared/skills.mjs';
import { hubService, runCommand } from '../shared/service.mjs';
import { tailscaleBin } from '../shared/tailscale.mjs';
import { inspectLinks, ownsStatusLine, hasWatcherStop, hubStatus, tailscaleState, runInstall } from './install.mjs';

const FIX = 'kickflip doctor --fix';
const MARKS = { ok: 'ok', fixable: 'fixable', yours: 'yours', optional: 'optional', note: 'note' };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
// Homebrew on macOS; apt elsewhere.
const INSTALL = {
  darwin: { git: 'xcode-select --install', gh: 'brew install gh', tmux: 'brew install tmux' },
  other: { git: 'sudo apt install git', gh: 'sudo apt install gh', tmux: 'sudo apt install tmux' },
};
// Checked when gh lists no repo of the owner's own.
const PUBLIC_REPO = 'cli/cli';
const REPO_TIMEOUT = 15_000;

const realPath = (file) => { try { return fs.realpathSync(file); } catch { return null; } };
const usedBy = (routes) => routes.length ? `${routes.map((route) => `/${route}`).join(', ')} ${routes.length > 1 ? 'use' : 'uses'} it` : '';

// Board clones in the places they lived before the clone home (../shared/repos.mjs reposDir): the running root's .repos
// folder, and any other .repos folder that holds a repo the manifest records for an open, closed or starting board.
// A folder with a .git entry is a clone. → [{clone, routes}] by path, routes naming the boards whose repo is in it.
export function oldBoardClones({ home = os.homedir(), cloneRoot = runningClone() } = {}) {
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), 'utf8')); } catch {}
  const recorded = [
    ...Object.entries(manifest.sites || {}).map(([route, site]) => [route, site?.owner?.repo]),
    ...Object.entries(manifest.closed || {}).map(([route, entry]) => [route, entry?.site?.owner?.repo]),
    ...Object.entries(manifest.starting || {}).map(([route, pending]) => [route, pending?.repo]),
  ].map(([route, repo]) => [route, repo && realPath(repo)]).filter(([, repo]) => repo);
  const marker = `${path.sep}.repos${path.sep}`;
  const bases = new Set([realPath(path.join(cloneRoot, '.repos')), ...recorded.map(([, repo]) => repo.includes(marker) ? repo.slice(0, repo.indexOf(marker) + marker.length - 1) : null)].filter(Boolean));
  const clones = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      if (fs.existsSync(path.join(sub, '.git'))) clones.push(sub);
      else walk(sub);
    }
  };
  for (const base of bases) walk(base);
  return clones.sort().map((clone) => ({ clone, routes: [...new Set(recorded.filter(([, repo]) => repo === clone || repo.startsWith(clone + path.sep)).map(([route]) => route))] }));
}

// → [{group: prereqs|setup|hub, item, state, detail, fix}]. state is ok; fixable, which `doctor --fix` sets up; yours,
// which only the person can fix with the fix command; optional, yours but not needed for the hub; or note, which the
// hub handles itself. Reads only: runs the read commands through run(command, argv, {env}) and asks the hub on port.
export async function doctorReport({ home = os.homedir(), cloneRoot = runningClone(), port = Number(process.env.KICKFLIP_HUB_PORT || 4500), uid = process.getuid(), env = process.env, run = runCommand, platform = process.platform, username = os.userInfo().username, fetch = globalThis.fetch, tailscale = tailscaleBin({ env, platform }) } = {}) {
  const hints = INSTALL[platform === 'darwin' ? 'darwin' : 'other'];
  const items = [];
  let group;
  const add = (item, state, detail, fix = null) => items.push({ group, item, state, detail, fix: state === 'ok' || state === 'note' ? null : fix });
  const execute = (command, argv, extraEnv = null, timeout = undefined) => {
    try { return run(command, argv, { env: extraEnv ? { ...env, ...extraEnv } : env, ...(timeout && { timeout }) }); } catch (e) { return { status: 1, error: e.message }; }
  };
  const installed = (item, command, argv, fix, missing = 'not on this session’s PATH') => {
    const r = execute(command, argv);
    const ok = r.status === 0;
    add(item, ok ? 'ok' : 'yours', ok ? (r.stdout || 'installed').trim().split('\n')[0] : missing, fix);
    return ok;
  };

  group = 'prereqs';
  const git = installed('git', 'git', ['--version'], hints.git);
  installed('node on Claude’s PATH', 'node', ['--version'], `add ${quote(path.dirname(process.execPath))} to PATH in your shell profile, then restart Claude Code`, `not on this session’s PATH (${env.PATH || 'empty'})`);
  const gh = installed('gh', 'gh', ['--version'], hints.gh);
  const ghAuth = gh && execute('gh', ['auth', 'status']).status === 0;
  add('gh signed in', ghAuth ? 'ok' : 'yours', ghAuth ? 'signed in' : gh ? 'not signed in' : 'needs gh', 'gh auth login');
  if (git) {
    const listed = ghAuth ? execute('gh', ['repo', 'list', '--limit', '1', '--json', 'nameWithOwner', '--jq', '.[0].nameWithOwner']) : null;
    const repo = (listed?.status === 0 && listed.stdout.trim()) || PUBLIC_REPO;
    const reach = execute('git', githubGitArgv(['ls-remote', `https://github.com/${repo}.git`, 'HEAD']), { GIT_TERMINAL_PROMPT: '0' });
    add('GitHub clone', reach.status === 0 ? 'ok' : 'yours',
      reach.status === 0 ? `git reaches ${repo} over https` : `git can’t reach ${repo} over https: ${reach.error}`,
      ghAuth ? 'gh auth refresh -h github.com, then kickflip doctor' : 'check this machine reaches https://github.com, then kickflip doctor');
  } else add('GitHub clone', 'yours', 'needs git', hints.git);
  const ts = await tailscaleState({ run: (command, argv) => execute(command, argv), platform, uid, username, port, tailscale });
  for (const entry of ts.prereqs) add(entry.item, entry.state, entry.detail, entry.fix);
  // Only a hub board's session needs tmux (../hub/sessions.mjs hubSession).
  const tmux = execute('tmux', ['-V']);
  add('tmux', tmux.status === 0 ? 'ok' : 'optional', tmux.status === 0 ? (tmux.stdout || 'installed').trim().split('\n')[0] : 'not installed; a hub board’s session (kickflip join --hub, kickflip hub) runs in it', hints.tmux);
  const codex = codexStatus({ home, env, platform });
  add('Codex', codex.usable ? 'ok' : 'optional', codex.usable ? 'installed and logged in' : `${codex.reason}; Codex builds and reviews need it`, codex.fix);
  const skills = skillsState({ home, run: execute, gh: ghAuth });
  if (skills.missing.length) add('mattpocock skills', 'optional', `${skills.missing.join(', ')} not installed; architecture reviews need ${skills.missing.length === 1 ? 'it' : 'them'}`, addCommand(skills.missing));
  else if (skills.stale.length) add('mattpocock skills', 'optional', `${skills.stale.join(', ')} out of date with ${SKILLS_SOURCE}`, updateCommand(skills.stale));
  else add('mattpocock skills', 'ok', `${REVIEW_SKILLS.join(', ')} installed${skills.checked ? ' and current' : ''}`);

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
  const stopHook = 'settings.json watcher Stop hook';
  if (settingsError) add(stopHook, 'yours', `unreadable: ${settingsError}`, `repair the JSON in ${quote(settingsFile)}, then ${FIX}`);
  else if (hasWatcherStop(settings)) add(stopHook, 'ok', 'runs hooks-plugin/hooks/watcher-stop.mjs');
  else add(stopHook, 'fixable', 'missing; a board session can end a turn with no live watcher or a message left Working on it', FIX);
  const autoCompact = 'settings.json autoCompactEnabled';
  if (settingsError) add(autoCompact, 'yours', `unreadable: ${settingsError}`, `repair the JSON in ${quote(settingsFile)}, then ${FIX}`);
  else if (settings.autoCompactEnabled === true) add(autoCompact, 'ok', 'on');
  else add(autoCompact, 'fixable', `${Object.hasOwn(settings, 'autoCompactEnabled') ? 'off' : 'not set'}; a board session that fills its context stops answering`, FIX);
  const service = hubService({ platform, home, uid, env, run });
  const login = service.status();
  add(service.item, login.running ? 'ok' : service.manager ? 'fixable' : 'yours', login.detail, service.manager ? FIX : `run ${service.restartCommand} under a service manager of your own`);
  for (const note of service.notes()) add(note.item, note.state, note.detail, note.fix);
  if (platform === 'darwin') {
    // Spotlight's Privacy list is root's (VolumeConfiguration.plist) and a .noindex folder isn't honoured, so doctor asks
    // the index for kickflip's manifest by name across ~/.claude: `mdfind -onlyin` a folder deeper than that finds nothing,
    // indexed or not (docs/adr/2026-11-06-1500-spotlight-privacy-is-the-owners-step.md).
    const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
    const found = execute('mdfind', ['-onlyin', path.join(home, '.claude'), 'kMDItemFSName == "manifest.json"']);
    if ((found.stdout || '').split('\n').includes(manifest)) add('Spotlight', 'yours', `indexes ~/.claude/kickflip, so every builder worktree drives its CPU up; ${FIX} can’t change that`, 'System Settings › Spotlight › Search Privacy (or Spotlight › Privacy): add ~/.claude/kickflip');
    else add('Spotlight', 'ok', 'skips ~/.claude/kickflip');
  }

  group = 'hub';
  const hub = await hubStatus({ port, fetch });
  add('hub', hub ? 'ok' : 'fixable', `${hub ? 'running' : 'not running'} on 127.0.0.1:${port}`, FIX);
  const { serveConfig } = ts;
  add(ts.root.item, ts.root.state, ts.root.detail, ts.root.fix);

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
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), 'utf8')); } catch {}
  const owners = new Map();
  const recorded = [...Object.entries(manifest.sites || {}), ...Object.entries(manifest.closed || {}).map(([route, entry]) => [route, entry.site]), ...sites.map((site) => [site.route, site])];
  for (const [route, site] of recorded) {
    if (!site?.dir) continue;
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(site.dir, 'data', 'try.json'), 'utf8')); } catch { continue; }
    if (isTryPort(state.main_port)) owners.set(Number(state.main_port), `/${route} main`);
    if (isTryPort(state.main?.https)) owners.set(Number(state.main.https), `/${route} main`);
    for (const [key, card] of Object.entries(state.cards || {})) if (isTryPort(card.https)) owners.set(Number(card.https), `/${route} ${key}`);
  }
  const ports = Object.keys(serveConfig?.TCP || {}).filter(isTryPort).sort((a, b) => a - b);
  add('try ports', 'ok', ports.map((port) => {
    const web = Object.entries(serveConfig.Web || {}).find(([host]) => host.endsWith(`:${port}`))?.[1];
    const target = web?.Handlers?.['/']?.Proxy || serveConfig.TCP[port].TCPForward || 'HTTPS';
    return `${port} → ${target} (${owners.get(Number(port)) || 'unknown'})`;
  }).join('; ') || 'none');
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
  // Each board repo the hub fetches (hub/try.mjs fetchTryBranches, which skips a local board), through git's own credential as the hub's fetch
  // uses it: GitHub clone above reaches a repo through gh's token, so it can pass while these fail.
  if (git) {
    for (const [route, site] of Object.entries(manifest.sites || {})) {
      const repo = site?.owner?.repo;
      if (!isBoardSite(site) || buildsLocally(site) || !repo) continue;
      const reach = execute('git', ['-C', repo, 'ls-remote', '--exit-code', 'origin', 'HEAD'], { GIT_TERMINAL_PROMPT: '0' }, REPO_TIMEOUT);
      const { error, hint } = gitReachFault(reach.error, { github: site.github || '', repo });
      add(`/${route} repo`, reach.status === 0 ? 'ok' : 'yours',
        reach.status === 0 ? `git reaches ${site.github || 'origin'} from ${repo}` : `git can’t reach ${site.github || 'origin'} from ${repo}: ${error}`, hint);
    }
  }
  for (const { clone, routes } of oldBoardClones({ home, cloneRoot })) {
    add('old board clone', 'optional', [`${clone} is in an old place`, `board clones now live in ${reposDir(home)}`, usedBy(routes)].filter(Boolean).join('; '), FIX);
  }
  return items;
}

export function doctorLines(items) {
  const width = Math.max(...Object.values(MARKS).map((mark) => mark.length));
  return items.flatMap((entry) => [`${MARKS[entry.state].padEnd(width)} ${entry.item}: ${entry.detail}`, ...(entry.fix ? [`${' '.repeat(width + 1)}→ ${entry.fix}`] : [])]);
}

// --fix runs install's steps, then asks through ask(question) → answer about each old board clone, removing the ones
// answered yes; with no ask (no terminal to ask in) it removes none.
export async function runDoctor({ fix = false, dryRun = false, json = false, write = console.log, error = console.error, install = runInstall, ask, ...options } = {}) {
  let failed = false;
  if (fix) {
    const log = json ? error : write;
    try { await install({ ...options, dryRun, log }); }
    catch (e) { failed = true; error('kickflip: ' + e.message); }
    const old = oldBoardClones(options);
    if (dryRun) {
      for (const { clone } of old) log(`would ask to remove the old board clone ${clone}`);
      return { items: [], exitCode: failed ? 1 : 0 };
    }
    for (const { clone, routes } of ask ? old : []) {
      const answer = await ask(`Remove the old board clone ${clone}? ${routes.length ? `${usedBy(routes)}. ` : ''}(y/N) `);
      if (!/^y(es)?$/i.test(answer.trim())) continue;
      fs.rmSync(clone, { recursive: true, force: true });
      log(`removed ${clone}`);
    }
  }
  const items = await doctorReport(options);
  write(json ? JSON.stringify({ items }, null, 2) : doctorLines(items).join('\n'));
  return { items, exitCode: failed || items.some((entry) => entry.state === 'fixable' || entry.state === 'yours') ? 1 : 0 };
}
