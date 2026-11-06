// A card's PRs, each in its own repo (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md). A wave entry stores
// prs: [{repo?: "owner/name", number, merged_at?}] in the order they were added, an entry without repo being in the
// board's repo, and merged_at the PR's merge mark once the board saw it merge
// (docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md); an older entry's pr: <n> is one PR in
// the board's repo. Every reader goes through cardPRs, and item set --pr writes the list.

const REF = /^(?:([\w.-]+\/[\w.-]+)#)?([1-9]\d*)$/;

// The stored list, an older pr: <n> read as [{number: n}].
export const storedPRs = (item) => (Array.isArray(item?.prs) ? item.prs : Number.isInteger(item?.pr) ? [{ number: item.pr }] : []);

// A wave entry → [{repo, number, merged_at?, kept?}], kept being an archived PR's last badges (store.mjs keptPRs).
// boardRepo is the board's GitHub repo or its wave's repo, which a PR stored without one is in; with no board repo that
// PR has no repo to read, so it is left out.
export const cardPRs = (item, boardRepo) => storedPRs(item).map((p) => ({ repo: p.repo || boardRepo, number: p.number, ...(p.merged_at ? { merged_at: p.merged_at } : {}), ...(p.kept ? { kept: p.kept } : {}) })).filter((p) => p.repo);

// Whether the wave entry has a PR at all, whatever its repo.
export const hasPR = (item) => storedPRs(item).length > 0;

export const prKeyOf = ({ repo, number }) => `${repo}#${number}`;
export const prURL = ({ repo, number }) => `https://github.com/${repo}/pull/${number}`;
// How a thread line names the card's PRs: #n in the board's repo, owner/repo#n in another.
export const prNames = (prs, boardRepo) => prs.map((p) => (p.repo && p.repo !== boardRepo ? prKeyOf(p) : `#${p.number}`)).join(', ');

// item set --pr's value, owner/repo#n or a bare n in the board's repo → the stored {repo?, number}, or null.
export function parsePRRef(value) {
  const m = REF.exec(String(value).trim());
  return m ? { ...(m[1] ? { repo: m[1] } : {}), number: Number(m[2]) } : null;
}

const FINISHED = ['MERGED', 'CLOSED'];
const failing = (s) => s.checks?.state === 'fail' || Boolean(s.failing?.length);
// How far a PR is from merging, by its GitHub state ({state, isDraft, reviewDecision, checks?.state | failing}): not
// read yet, draft, failing CI, waiting on review, approved, then merged or closed.
function readiness(s) {
  if (!s?.state) return 0;
  if (FINISHED.includes(s.state)) return 5;
  if (s.isDraft) return 1;
  if (failing(s)) return 2;
  return s.reviewDecision === 'APPROVED' ? 4 : 3;
}

// The GitHub states of a card's PRs, in its order (null for one not read) → the index of the one that decides the
// card's lane and Next: the least ready, the first of a tie. Once every PR has merged or closed, a merged one, so the
// card reads merged when at least one merged.
export function leastReady(states) {
  if (!states.length) return -1;
  const ranks = states.map(readiness);
  if (ranks.every((r) => r === 5)) return Math.max(0, states.findIndex((s) => s.state === 'MERGED'));
  return ranks.indexOf(Math.min(...ranks));
}

// Whether the card's PRs are done: every one merged or closed, at least one merged.
export const allLanded = (states) => states.length > 0 && states.every((s) => FINISHED.includes(s?.state)) && states.some((s) => s.state === 'MERGED');
