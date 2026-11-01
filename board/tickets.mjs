import { runRepo, validateGithub } from '../hub/repos.mjs';

const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export function ticketSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Tickets must name a source.');
  const allowed = { internal: ['source', 'prefix'], github: ['source'], linear: ['source', 'workspace', 'team', 'project'] };
  if (!Object.hasOwn(allowed, value.source)) refuse('Ticket source must be internal, github or linear.');
  if (Object.keys(value).some((k) => !allowed[value.source].includes(k))) refuse('Unknown ticket source field.');
  if (value.source === 'internal') {
    const prefix = value.prefix === undefined || value.prefix === '' ? 'INT' : value.prefix;
    if (typeof prefix !== 'string' || !/^[A-Z]{2,6}$/.test(prefix)) refuse('Prefix must be 2–6 uppercase letters.');
    return { source: 'internal', prefix };
  }
  if (value.source === 'github') return { source: 'github' };
  if (typeof value.workspace !== 'string' || !/^[a-z\d][a-z\d-]*$/i.test(value.workspace)) refuse('Linear needs a workspace.');
  if (typeof value.team !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(value.team)) refuse('Linear needs an uppercase team key.');
  if (typeof value.project !== 'string' || !value.project.trim()) refuse('Linear needs a project.');
  return { source: 'linear', workspace: value.workspace, team: value.team, project: value.project.trim() };
}

const numberOf = (match) => {
  const n = match ? Number(match[1]) : null;
  return Number.isSafeInteger(n) ? n : null;
};
const issueNumber = (id) => numberOf(/^#?([1-9]\d*)$/.exec(String(id ?? '')));
const keyOf = (source) => (source.source === 'internal' ? source.prefix || 'INT' : source.source === 'linear' ? source.team : null);

// The number of a stored ticket id that belongs to the source (PREFIX-n, #n or TEAM-n), else null: an id from
// another source is never relabelled as this one's.
export function ticketIn(source, id) {
  if (!source) return null;
  const key = keyOf(source);
  const s = String(id ?? '');
  if (!key) return numberOf(/^#([1-9]\d*)$/.exec(s));
  return s.startsWith(`${key}-`) ? numberOf(/^([1-9]\d*)$/.exec(s.slice(key.length + 1))) : null;
}

export function ticketBadge(source, id, { repo, key } = {}) {
  const n = ticketIn(source, id);
  if (!n) return null;
  if (source.source === 'internal') return { id: `${keyOf(source)}-${n}`, url: `#item=${encodeURIComponent(key)}`, source: 'internal' };
  if (source.source === 'github') return repo ? { id: `#${n}`, url: `https://github.com/${repo}/issues/${n}`, source: 'github' } : null;
  const ref = `${source.team}-${n}`;
  return { id: ref, url: `https://linear.app/${source.workspace}/issue/${ref}`, source: 'linear' };
}

export async function resolveTicket(source, { ticket, title, body = '', repo, next }, { run = runRepo } = {}) {
  if (source.source === 'internal') {
    if (ticket !== undefined && !ticketIn(source, ticket)) refuse(`Ticket must match ${source.prefix}-<number>.`);
    return ticket ?? `${source.prefix}-${next}`;
  }
  if (source.source === 'linear') {
    if (ticket === undefined) refuse('The Linear key comes in phase 2; pass --ticket <id>.');
    if (!ticketIn(source, ticket)) refuse(`Ticket must match ${source.team}-<number>.`);
    return ticket;
  }
  validateGithub(repo);
  const n = ticket === undefined ? null : issueNumber(ticket);
  if (ticket !== undefined && !n) refuse('GitHub ticket must be an issue number such as #41.');
  const argv = n ? ['issue', 'view', String(n), '--repo', repo, '--json', 'number,url']
    : ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  const out = await run('gh', argv);
  if (out.status !== 0) refuse((out.stderr || 'GitHub refused the issue.').trim().split('\n')[0]);
  let url;
  if (n) {
    let issue;
    try { issue = JSON.parse(out.stdout); } catch { refuse('GitHub returned an invalid issue.'); }
    if (issue.number !== n) refuse('GitHub returned a different issue.');
    url = issue.url;
  } else url = out.stdout?.trim();
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(url || '');
  if (!match || match[1].toLowerCase() !== repo.toLowerCase() || (n && Number(match[2]) !== n) || !issueNumber(match[2])) refuse('Ticket must be an issue in the board’s repo.');
  return `#${match[2]}`;
}
