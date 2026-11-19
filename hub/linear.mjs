// Linear through the owner's personal API key (docs/adr/2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md).
// The key lives in secrets.json's `linear` (secrets.mjs): {key, workspace, url_key, viewer, saved_at}, plus
// refused_at once Linear refused it (docs/adr/2026-11-02-1712-a-board-picks-linear-only-while-hubs-key-works.md). Only
// linearStatus's {set, refused, workspace, url_key} ever leaves this module for a page.
// Every request goes to KICKFLIP_LINEAR_URL when it is set, else Linear's GraphQL API, through the fetch passed in.
import { aToZ } from '../shared/a-to-z.mjs';
import { readSecret, writeSecret } from './secrets.mjs';

export class LinearError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const endpoint = () => process.env.KICKFLIP_LINEAR_URL || 'https://api.linear.app/graphql';

export function readLinearKey(home) {
  const saved = readSecret('linear', home);
  return typeof saved?.key === 'string' && saved.key ? saved : null;
}

export function linearStatus(home) {
  const saved = readLinearKey(home);
  if (!saved) return { set: false };
  return { set: true, ...(saved.refused_at ? { refused: true } : {}), ...(saved.workspace ? { workspace: saved.workspace, url_key: saved.url_key } : {}) };
}

// A board picks Linear for its tickets only while Hub's key is saved and Linear hasn't refused it
// (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).
export const linearWorks = (home) => { const status = linearStatus(home); return status.set && !status.refused; };
export const LINEAR_NEEDS_KEY = 'Linear needs Hub’s Linear key; add it in Hub › Integrations › Linear first, or pick GitHub issues or None.';

// Personal API keys go in the Authorization header as they are, with no Bearer prefix (Linear's API docs).
// checked(works) follows each answer: false when Linear refused the key, true when it answered with data.
export function linearClient(key, { fetch = globalThis.fetch, checked = () => {} } = {}) {
  async function call(query, variables = {}) {
    let r;
    try {
      r = await fetch(endpoint(), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) { throw new LinearError(`Could not reach Linear: ${e.message}`); }
    const out = await r.json().catch(() => null);
    if (r.status === 401 || out?.errors?.some((e) => e.extensions?.type === 'authentication error')) {
      checked(false);
      throw new LinearError('Linear refused the key.', 400);
    }
    if (out?.errors?.length) {
      const e = out.errors[0];
      throw Object.assign(new LinearError(`Linear: ${e.message}`), { notFound: e.extensions?.type === 'not found' || /not found/i.test(e.message) });
    }
    if (!r.ok || !out?.data) throw new LinearError(`Linear answered ${r.status}.`);
    checked(true);
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
    // → [{id, key, name, projects: [{id, name}]}]: teams A–Z by key, each team's open projects (not completed or canceled) A–Z by name
    async teams() {
      // Linear refuses a query whose nested page sizes multiply past its complexity limit ("Query too complex"), so
      // each team's projects come in a query of their own.
      const d = await call('query { teams(first: 100) { nodes { id key name } } }');
      const teams = await Promise.all(d.teams.nodes.map(async (t) => {
        const p = await call('query($id: String!) { team(id: $id) { projects(first: 100) { nodes { id name status { type } } } } }', { id: t.id });
        const open = p.team.projects.nodes.filter((x) => !['completed', 'canceled'].includes(x.status?.type));
        return { id: t.id, key: t.key, name: t.name, projects: aToZ(open.map((x) => ({ id: x.id, name: x.name })), (x) => x.name) };
      }));
      return aToZ(teams, (t) => t.key);
    },
    async createProject(teamKey, name) {
      const t = await team(teamKey);
      const d = await call('mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name } } }', { input: { name, teamIds: [t.id] } });
      if (!d.projectCreate.success) throw new LinearError('Linear did not create the project.');
      return { ...d.projectCreate.project, team: t.key };
    },
    // project is the source's project, by id or name; assignee a user id the issue is assigned to. → {identifier, url}
    async createIssue({ team: teamKey, project, title, description, assignee }) {
      const t = await team(teamKey);
      const input = { teamId: t.id, projectId: projectOf(t, project).id, title, ...(description ? { description } : {}), ...(assignee ? { assigneeId: assignee } : {}) };
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
    async advanceIssue(identifier, target, { owner, created } = {}) {
      const issue = await api.issue(identifier);
      if (!issue || (issue.assignee !== owner && !created) || stageOf(issue.state) >= { started: 1, review: 2, done: 3 }[target]) return null;
      const state = stateFor((await team(issue.team)).states.nodes, target);
      if (!state) return null;
      const d = await call('mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }', { id: identifier, stateId: state.id });
      if (!d.issueUpdate.success) throw new LinearError('Linear did not move the issue.');
      return state.name;
    },
    async commentIssue(identifier, body) {
      const d = await call('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: identifier, body } });
      if (!d.commentCreate.success) throw new LinearError('Linear did not post the comment.');
    },
    async assignIssue(identifier, assignee) {
      const d = await call('mutation($id: String!, $assigneeId: String!) { issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success } }', { id: identifier, assigneeId: assignee });
      if (!d.issueUpdate.success) throw new LinearError('Linear did not assign the issue.');
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

export function stageOf(state) {
  if (['completed', 'canceled'].includes(state.type)) return 3;
  if (state.type === 'started') return /review/i.test(state.name) ? 2 : 1;
  return 0;
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

// Checks the key with Linear and saves it, as refused when Linear refuses it. Any other failure saves nothing.
// → linearStatus()
export async function saveLinearKey(key, { fetch } = {}) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k || /\s/.test(k) || k.length > 200) throw new LinearError('Paste a Linear personal API key.', 400);
  const now = new Date().toISOString();
  let refused = false;
  const who = await linearClient(k, { fetch, checked: (works) => { refused = !works; } }).viewer().catch((e) => { if (!refused) throw e; return null; });
  writeSecret('linear', who ? { key: k, ...who, saved_at: now } : { key: k, saved_at: now, refused_at: now });
  return linearStatus();
}

// Remembers whether Linear refused the saved key, from the newest answer to a call with it.
function markChecked(key, works) {
  const saved = readLinearKey();
  if (saved?.key !== key || Boolean(saved.refused_at) === !works) return;
  const { refused_at: _, ...rest } = saved;
  writeSecret('linear', works ? rest : { ...rest, refused_at: new Date().toISOString() });
}

export function removeLinearKey() {
  writeSecret('linear', null);
  return linearStatus();
}

// A client over the saved key, or null when none is saved. Its calls keep the key's refused_at up to date.
export function savedClient({ fetch } = {}) {
  const saved = readLinearKey();
  return saved ? { ...linearClient(saved.key, { fetch, checked: (works) => markChecked(saved.key, works) }), saved } : null;
}
