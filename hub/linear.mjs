// Linear through the owner's personal API key (docs/adr/0088-kickflip-reaches-linear-with-a-key-on-the-mac.md).
// The key lives in ~/.claude/kickflip/linear.json, mode 600: {key, workspace, url_key, viewer, saved_at}. Only
// linearStatus's {set, workspace, url_key} ever leaves this module for a page.
// Every request goes to KICKFLIP_LINEAR_URL when it is set, else Linear's GraphQL API, through the fetch passed in.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class LinearError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const keyFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'linear.json');
const endpoint = () => process.env.KICKFLIP_LINEAR_URL || 'https://api.linear.app/graphql';

export function readLinearKey() {
  try {
    const saved = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
    return typeof saved?.key === 'string' && saved.key ? saved : null;
  } catch { return null; }
}

export function linearStatus() {
  const saved = readLinearKey();
  return saved ? { set: true, workspace: saved.workspace, url_key: saved.url_key } : { set: false };
}

// Personal API keys go in the Authorization header as they are, with no Bearer prefix (Linear's API docs).
export function linearClient(key, { fetch = globalThis.fetch } = {}) {
  async function call(query, variables = {}) {
    let r;
    try {
      r = await fetch(endpoint(), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) { throw new LinearError(`Could not reach Linear: ${e.message}`); }
    const out = await r.json().catch(() => null);
    if (r.status === 401 || out?.errors?.some((e) => e.extensions?.type === 'authentication error')) throw new LinearError('Linear refused the key.', 400);
    if (out?.errors?.length) {
      const e = out.errors[0];
      throw Object.assign(new LinearError(`Linear: ${e.message}`), { notFound: e.extensions?.type === 'not found' || /not found/i.test(e.message) });
    }
    if (!r.ok || !out?.data) throw new LinearError(`Linear answered ${r.status}.`);
    return out.data;
  }

  const teamFields = 'id key name states { nodes { id name type position } } projects(first: 100) { nodes { id name } }';
  async function team(key) {
    const d = await call(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { ${teamFields} } } }`, { key });
    return d.teams.nodes[0] || (() => { throw new LinearError(`Linear has no team ${key}.`, 400); })();
  }
  const projectOf = (t, project) => t.projects.nodes.find((p) => p.id === project)
    || t.projects.nodes.find((p) => p.name.toLowerCase() === String(project).toLowerCase())
    || (() => { throw new LinearError(`Linear's ${t.key} team has no project ${project}.`, 400); })();

  const api = {
    async viewer() {
      const d = await call('query { viewer { id name } organization { name urlKey } }');
      return { viewer: { id: d.viewer.id, name: d.viewer.name }, workspace: d.organization.name, url_key: d.organization.urlKey };
    },
    // → [{id, key, name, projects: [{id, name}]}]
    async teams() {
      const d = await call('query { teams(first: 100) { nodes { id key name projects(first: 100) { nodes { id name } } } } }');
      return d.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name, projects: t.projects.nodes.map((p) => ({ id: p.id, name: p.name })) }));
    },
    async createProject(teamKey, name) {
      const t = await team(teamKey);
      const d = await call('mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }', { input: { name, teamIds: [t.id] } });
      if (!d.projectCreate.success) throw new LinearError('Linear did not create the project.');
      return { ...d.projectCreate.project, team: t.key };
    },
    // project is the source's project, by id or name. → {identifier, url}
    async createIssue({ team: teamKey, project, title, description }) {
      const t = await team(teamKey);
      const input = { teamId: t.id, projectId: projectOf(t, project).id, title, ...(description ? { description } : {}) };
      const d = await call('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }', { input });
      if (!d.issueCreate.success) throw new LinearError('Linear did not create the issue.');
      return d.issueCreate.issue;
    },
    // → {identifier, team, assignee, state: {id, name, type}} or null when Linear has no such issue.
    async issue(identifier) {
      try {
        const d = await call('query($id: String!) { issue(id: $id) { identifier team { key } assignee { id } state { id name type } } }', { id: identifier });
        return d.issue ? { identifier: d.issue.identifier, team: d.issue.team.key, assignee: d.issue.assignee?.id ?? null, state: d.issue.state } : null;
      } catch (e) { if (e.notFound) return null; throw e; }
    },
    // → the state's name when the issue moved, else null (already there, closed, or no state fits the target).
    async moveIssue(identifier, target) {
      const issue = await api.issue(identifier);
      if (!issue) throw new LinearError(`Linear has no issue ${identifier}.`, 400);
      if (['completed', 'canceled'].includes(issue.state.type)) return null;
      const state = stateFor((await team(issue.team)).states.nodes, target);
      if (!state || state.id === issue.state.id) return null;
      const d = await call('mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }', { id: identifier, stateId: state.id });
      if (!d.issueUpdate.success) throw new LinearError('Linear did not move the issue.');
      return state.name;
    },
  };
  return api;
}

// A team's workflow state for a card's target, by Linear's state type and then by name: started is the started-type
// state named In Progress, else the first started one not about review; review is a started-type state whose name
// says review, else none; done is the completed-type state named Done, else the first completed one.
export function stateFor(states, target) {
  const sorted = [...states].sort((a, b) => a.position - b.position);
  const of = (type) => sorted.filter((s) => s.type === type);
  const review = (s) => /review/i.test(s.name);
  if (target === 'started') return of('started').find((s) => /^in progress$/i.test(s.name)) || of('started').find((s) => !review(s)) || null;
  if (target === 'review') return of('started').find(review) || null;
  if (target === 'done') return of('completed').find((s) => /^done$/i.test(s.name)) || of('completed')[0] || null;
  return null;
}

// Saves the key once Linear accepts it. → linearStatus()
export async function saveLinearKey(key, { fetch } = {}) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k || /\s/.test(k) || k.length > 200) throw new LinearError('Paste a Linear personal API key.', 400);
  const who = await linearClient(k, { fetch }).viewer();
  const file = keyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ key: k, ...who, saved_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return linearStatus();
}

export function removeLinearKey() {
  fs.rmSync(keyFile(), { force: true });
  return linearStatus();
}

// A client over the saved key, or null when none is saved.
export function savedClient({ fetch } = {}) {
  const saved = readLinearKey();
  return saved ? { ...linearClient(saved.key, { fetch }), saved } : null;
}
