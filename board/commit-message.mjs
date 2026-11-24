// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md, amended by
// docs/adr/2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md
// The commit message standard: a Conventional subject of at most 100 characters, ending " (<ticket>)" when the card has
// a ticket, and `Refs: <ref>` trailers for the card's ticket and its related cards' tickets, none for a card with no
// ticket. Land writes its squash commit to it and checks the subject, finish checks a PR title by it, and the briefs
// and the release script write to it.

export const TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'build', 'ci', 'style', 'revert'];
export const SUBJECT_MAX = 100;
// A scope is a lowercase area, or a comma list of them for a change across several: (board), (api,web), (api, web).
const SCOPE = '\\([a-z][a-z0-9-]*(?:, ?[a-z][a-z0-9-]*)*\\)';
const SHAPE = new RegExp(`^(${TYPES.join('|')})(${SCOPE})?!?: \\S`);

// A subject ending " (<ticket>)", the card's ticket, as a landed commit's and a PR's title do; subject as it is with
// no ticket or when it ends so already.
export const withTicket = (subject, ticket) => (!ticket || subject.endsWith(` (${ticket})`) ? subject : `${subject} (${ticket})`);

// The standard as one sentence, for a brief or a refusal; ticket is the card's, null for a card with no ticket.
export const standardWords = (ticket) =>
  `a Conventional subject of at most ${ticket ? SUBJECT_MAX - ` (${ticket})`.length : SUBJECT_MAX} characters, "<type>(<scope>): <summary>", the type one of ${TYPES.slice(0, -1).join(', ')} or ${TYPES.at(-1)} `
  + `(a "!" after the type or scope for a breaking change), the scope optional, lowercase and naming the area (board, hub, skill), or a comma list of areas for a change across them (api,web), and no task ref in it${ticket ? ` (the land adds " (${ticket})")` : ''}; `
  + (ticket
    ? `then a blank line, the detail wrapped at 72, and the trailers "Refs: ${ticket}" on the line directly above Co-Authored-By, no blank line between`
    : 'then a blank line, the detail wrapped at 72, and the Co-Authored-By trailer, with no Refs line: the task has no ticket, so nothing outside the board names it')
  + '. A commit message leaves the board: it cites earlier work by its ticket, PR or commit, never a task key such as T-12, and work that never left the board not at all';

// → why subject isn't a Conventional subject within the cap, or null when it is.
export function subjectFault(subject) {
  if (!SHAPE.test(subject)) return `isn't "<type>(<scope>): <summary>" with the type one of ${TYPES.join(', ')} and a lowercase scope or a comma list of them`;
  if (subject.length > SUBJECT_MAX) return `is ${subject.length} characters, over ${SUBJECT_MAX}`;
  return null;
}

// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md
// A card's title is the subject its PR and squash commit take, or, for a question about the board, an ask:
// "ask(<scope>): <question>?". → why title isn't one, or null when it is.
const ASK = new RegExp(`^ask(${SCOPE})?: \\S.*\\?$`);
const isAsk = (title) => /^ask[(:]/.test(title);
export function cardTitleFault(title) {
  if (!isAsk(title)) return subjectFault(title);
  if (!ASK.test(title)) return 'isn\'t "ask(<scope>): <question>?", ending with "?"';
  if (title.length > SUBJECT_MAX) return `is ${title.length} characters, over ${SUBJECT_MAX}`;
  return null;
}
// How a card's title is written, for a refusal.
export const cardTitleWords = `"<type>(<scope>): <summary>" of at most ${SUBJECT_MAX} characters, or "ask(<scope>): <question>?" for a question`;

// Why the card key titled title can't go into In Progress, naming the fix, or null when it can: its title is the
// subject its PR takes, and an ask is answered, not built.
const startFault = (title) => (isAsk(title) ? 'is an ask, which is answered, not built' : subjectFault(title));
export function startTitleFault(key, title) {
  const fault = startFault(title);
  return fault && `${key}'s title "${title}" ${fault}; retitle it with item set ${key} --title "<type>(<scope>): <summary>" before it goes into In Progress`;
}
// The same refusal in a status line's room (hub-lines.mjs build-refused): its reason first, with no title quoted and
// the type list and the command left to startTitleFault, so the reason is never what gets cut. null when title builds.
export function startTitleBrief(title) {
  const fault = startFault(title);
  if (!fault) return null;
  return `its title ${isAsk(title) || SHAPE.test(title) ? fault : 'isn\'t <type>(<scope>): <summary>'}; retitle it`;
}

// A release commit's message: "chore(release): <version>", then the subjects landed since the last tag, oldest first,
// then "Refs: <ref>", the release card's.
export const releaseMessage = (version, subjects, ref) => [`chore(release): ${version}`, withTrailers(subjects.map((s) => `- ${s}`).join('\n'), [ref], [])].join('\n\n');
// The version a release commit's subject names, with or without its ticket's " (<ticket>)", or null when subject isn't one.
export const releaseVersion = (subject) => /^chore\(release\): (\S+)(?: \([^()\s]+\))?$/.exec(subject)?.[1] ?? null;

// A squash merge's body, below the PR title as its subject: the PR body's Summary section wrapped at 72 as the detail,
// then the trailers, "Refs: <ref>" for each of refs and each Co-Authored-By the PR's commits carry, once whatever its
// case. commits are gh's ({messageBody}).
export const squashBody = (refs, body, commits) => withTrailers(detailOf(body), refs, commits.map((c) => c.messageBody));

// docs/adr/2026-11-24-2300-a-commit-body-is-the-pr-descriptions-summary-as-plain-text.md
// A commit's detail from a PR body, on both paths (a PR's merge and a no-PR land): its Summary section as plain text,
// wrapped at 72.
const detailOf = (body) => wrap(plain(summaryOf(body)));

// markdown as plain prose: heading marks, emphasis, code ticks and fences, link targets and HTML tags gone, their
// words kept. List dashes and quote marks stay, as prose uses them.
const plain = (text) => text
  .replace(/^[ \t]*(```|~~~).*\n?/gm, '')
  .replace(/^#{1,6}\s+(.*?)\s*#*\s*$/gm, '$1')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<\/?[a-z][^>]*>/gi, '')
  .replace(/(\*\*|__)(.+?)\1/g, '$2')
  .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, '$2')
  .replace(/`+([^`\n]*)`+/g, '$1');

// The PR body's Summary section: the lines under its "Summary" heading, of any level, down to the next heading of that
// level or higher, with the body's HTML comments (a template's notes) left out; the whole body when no heading says
// Summary, as a hand-written PR's may not.
function summaryOf(body) {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const level = (line) => /^(#{1,6})\s/.exec(line)?.[1].length ?? Infinity;
  const at = lines.findIndex((l) => /^#{1,6}\s+summary\s*#*\s*$/i.test(l));
  if (at < 0) return lines.join('\n');
  const end = lines.findIndex((l, i) => i > at && level(l) <= level(lines[at]));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

// text with each line over WRAP characters broken between words, a list item's or quote's later lines indented under
// its first word, and a fenced code block's lines kept as they are.
const WRAP = 72;
function wrap(text) {
  let fenced = false;
  return text.replace(/\n{3,}/g, '\n\n').split('\n').flatMap((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || line.length <= WRAP) return [line];
    const lead = /^\s*(?:[-*+] |\d+[.)] |> )?/.exec(line)[0];
    const hang = lead.trimStart().startsWith('>') ? lead : ' '.repeat(lead.length);
    const out = [];
    let words = '';
    for (const word of line.slice(lead.length).split(/\s+/).filter(Boolean)) {
      const prefix = out.length ? hang : lead;
      if (words && prefix.length + words.length + 1 + word.length > WRAP) {
        out.push(prefix + words);
        words = word;
      } else words = words ? `${words} ${word}` : word;
    }
    return [...out, (out.length ? hang : lead) + words];
  }).join('\n');
}

const REFS = /^Refs: /i;
const COAUTHOR = /^Co-Authored-By: /i;
const once = (lines) => [...new Map(lines.map((l) => [l.toLowerCase(), l])).values()];

// detail, then one trailer block with no blank line in it: "Refs: <ref>" for each of refs, then each Co-Authored-By
// line in messages, once whatever its case.
function withTrailers(detail, refs, messages) {
  const coauthors = once(messages.flatMap((m) => m.split('\n').filter((l) => COAUTHOR.test(l))));
  return [detail.trim(), [...refs.map((r) => `Refs: ${r}`), ...coauthors].join('\n')].filter(Boolean).join('\n\n');
}

// docs/adr/2026-11-11-2318-every-land-squashes-the-branch-into-one-commit.md
// A land's squash commit message from messages, the branch's commit messages, its first commit's first: title, else
// that first subject, ending " (<ticket>)" with a ticket; body, the card's kept PR body, as a PR merge's detail, else
// the first commit's detail, its Refs and Co-Authored-By lines left out; then the trailer block, "Refs: <ref>" for each of refs (with no refs given, a land with no card, each Refs
// the messages carry, once) and each Co-Authored-By they carry, once.
export function squashMessage(messages, { refs, ticket, title, body: prBody } = {}) {
  const [subject, ...rest] = messages[0].split('\n');
  const detail = prBody ? detailOf(prBody) : rest.filter((l) => !REFS.test(l) && !COAUTHOR.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
  const kept = refs ?? once(messages.flatMap((m) => m.split('\n').filter((l) => REFS.test(l)).map((l) => l.replace(REFS, '').trim())));
  return [withTicket(title ?? subject, ticket), withTrailers(detail, kept, messages)].filter(Boolean).join('\n\n');
}
