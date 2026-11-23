// docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
// The hub's sweep of what kickflip leaves on disk, run as the hub starts and once a day: the worktrees under
// ~/.claude/kickflip/worktrees a task's close left (board/runs.mjs removeCardWorktrees keeps one holding work that never
// landed, and one a running build still works in), folders there git no longer lists, and the agent and failed-land logs
// past KEEP_DAYS. It runs in the hub's process, so every git call and file read, removal and stat is async: the
// biggest sweep, the first, never holds the hub's event loop.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBoardSite, readManifest } from './boards.mjs';
import { KEEP_DAYS } from './host-load-log.mjs';
import { itemSources, readJSON } from '../board/files.mjs';
import { readArchive } from '../board/cards.mjs';
import { AGENT_LOG, launchLives } from '../board/headless.mjs';
import { LAND_LOG, gitAsync, removeClosedWorktree, worktreesDir } from '../board/worktree.mjs';
import { storedPRs } from '../shared/card-prs.mjs';

const DAY = 86400_000;
const KEEP = KEEP_DAYS * DAY;
const list = (dir) => fs.readdir(dir).catch(() => []);

// Each worktree path a board's builder records name → the records naming it, [{key, item, tree, base, started, live}]:
// item the card as its item file or Done archive holds it, else null; base the branch its build came from, the card's
// own PR base else the board's branch else main, as board/worktree.mjs builderRepo reads it; live while a run the board
// launched for that record's agent lives.
async function recordedTrees(manifest) {
  const found = new Map();
  for (const site of Object.values(manifest.sites || {}).filter(isBoardSite)) {
    const archived = new Map((await readArchive(site.dir)).map((c) => [c.key, c.item]));
    for (const source of await itemSources(site.dir)) {
      const items = (await readJSON(source.file, null))?.items ?? [];
      const agents = path.join(source.dir, 'agents');
      for (const name of (await list(agents)).filter((n) => n.endsWith('.json'))) {
        const record = await readJSON(path.join(agents, name), null);
        if (!record?.worktree?.path) continue;
        const [id, agent = 'main'] = name.slice(0, -'.json'.length).split('@');
        const key = `${source.slug}/${id}`;
        const item = items.find((it) => it?.id === id) ?? archived.get(key) ?? null;
        const at = path.resolve(record.worktree.path);
        const use = { key, item, tree: record.worktree, base: item?.base || site.branch || 'main', started: record.started ?? '', live: launchLives(site.dir, key, agent) };
        found.set(at, [...(found.get(at) ?? []), use]);
      }
    }
  }
  return found;
}

// Whether git still lists the worktree at dir: its .git file names a worktree folder of its repo that is there.
async function listed(dir) {
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(await fs.readFile(path.join(dir, '.git'), 'utf8'))?.[1];
    return Boolean(gitdir) && await fs.stat(path.resolve(dir, gitdir)).then(() => true, () => false);
  } catch (e) { return e.code === 'EISDIR'; }
}

// The agent logs (board/headless.mjs AGENT_LOG) and failed-land logs (board/worktree.mjs LAND_LOG) in logs last written
// over KEEP_DAYS ago, deleted. → their names
async function expireLogs(logs, now) {
  const expired = [];
  for (const name of await list(logs)) {
    if (!AGENT_LOG.test(name) && !LAND_LOG.test(name)) continue;
    const file = path.join(logs, name);
    if (now - (await fs.stat(file)).mtimeMs <= KEEP) continue;
    await fs.rm(file, { force: true });
    expired.push(name);
  }
  return expired;
}

// The folders the sweep looks at: each under the worktrees folder, and each under a board's route folder
// (board/worktree.mjs worktreePath), which is no worktree itself.
async function worktreeFolders(root, manifest) {
  const routes = new Set(Object.entries(manifest.sites || {}).filter(([, site]) => isBoardSite(site)).map(([route]) => route));
  const found = [];
  for (const name of await list(root)) {
    const dir = path.join(root, name);
    const holdsTrees = routes.has(name) && !await fs.stat(path.join(dir, '.git')).then(() => true, () => false);
    if (holdsTrees) found.push(...(await list(dir)).map((child) => path.join(dir, child)));
    else found.push(dir);
  }
  return found;
}

// One sweep. Each folder under the worktrees folder goes, its branch with it, when every record naming it is a closed
// card's with no launched run alive: at once when it holds no work that never landed (a merged PR's commits landed),
// else KEEP_DAYS after the newest card's close. A folder git no longer lists goes once a day old, as a younger one may
// be a worktree being added. One no record names, or an open card's, stays. git worktree prune then runs in each repo a
// worktree was removed from. → {worktrees: the folders removed, logs: the log files deleted, failed: ["<folder>: why"]}
export async function sweepLeftovers({ manifest = readManifest(), now = Date.now() } = {}) {
  const trees = await recordedTrees(manifest);
  const root = worktreesDir();
  const worktrees = [];
  const failed = [];
  const repos = new Set();
  for (const dir of await worktreeFolders(root, manifest)) {
    try {
      if (!await listed(dir)) {
        if (now - (await fs.stat(dir)).mtimeMs > DAY) { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }); worktrees.push(dir); }
        continue;
      }
      const uses = trees.get(dir) ?? [];
      if (!uses.length || uses.some((u) => u.live || u.item?.lane !== 'done')) continue;
      const { tree, base, item } = uses.reduce((a, b) => (b.started > a.started ? b : a));
      const closedAt = Math.max(...uses.map((u) => Date.parse(u.item.closed_at) || 0));
      const why = await removeClosedWorktree(tree, { base, landed: storedPRs(item).some((p) => p.merged_at), force: now - closedAt >= KEEP });
      repos.add(tree.repo);
      if (!why) worktrees.push(dir);
    } catch (e) { failed.push(`${dir}: ${e.message}`); }
  }
  for (const repo of repos) await gitAsync(repo, 'worktree', 'prune');
  return { worktrees, logs: await expireLogs(path.join(os.homedir(), '.claude', 'kickflip', 'logs'), now), failed };
}
