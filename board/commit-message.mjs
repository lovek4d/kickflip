// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
// The commit message standard: a Conventional subject of at most 100 characters with no card ref in it, and the card's
// ref in a `Refs: <ref>` trailer. Land writes its squash commit to it and checks the subject, finish checks a PR title
// by it, and the briefs and the release script write to it.

export const TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'build', 'ci', 'style', 'revert'];
export const SUBJECT_MAX = 100;
const SHAPE = new RegExp(`^(${TYPES.join('|')})(\\([a-z][a-z0-9-]*\\))?!?: \\S`);

// The standard as one sentence, for a brief or a refusal; ref is the card's, else a placeholder.
export const standardWords = (ref = '<ref>') =>
  `a Conventional subject of at most ${SUBJECT_MAX} characters, "<type>(<scope>): <summary>", the type one of ${TYPES.slice(0, -1).join(', ')} or ${TYPES.at(-1)} `
  + `(a "!" after the type or scope for a breaking change), the scope optional, lowercase and naming the area (board, hub, skill), and no card ref in it; `
  + `then a blank line, the detail wrapped at 72, and the trailers "Refs: ${ref}" on the line directly above Co-Authored-By, no blank line between`;

// → why subject isn't a Conventional subject within the cap, or null when it is.
export function subjectFault(subject) {
  if (!SHAPE.test(subject)) return `isn't "<type>(<scope>): <summary>" with the type one of ${TYPES.join(', ')} and a lowercase scope`;
  if (subject.length > SUBJECT_MAX) return `is ${subject.length} characters, over ${SUBJECT_MAX}`;
  return null;
}

// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md
// A card's title is the subject its PR and squash commit take, or, for a question about the board, an ask:
// "ask(<scope>): <question>?". → why title isn't one, or null when it is.
const ASK = /^ask(\([a-z][a-z0-9-]*\))?: \S.*\?$/;
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
export function startTitleFault(key, title) {
  const fault = isAsk(title) ? 'is an ask, which is answered, not built' : subjectFault(title);
  return fault && `${key}'s title "${title}" ${fault}; retitle it with item set ${key} --title "<type>(<scope>): <summary>" before it goes into In Progress`;
}

// A release commit's message: "chore(release): <version>", then the subjects landed since the last tag, oldest first,
// then "Refs: <ref>", the release card's.
export const releaseMessage = (version, subjects, ref) => [`chore(release): ${version}`, withTrailers(subjects.map((s) => `- ${s}`).join('\n'), [ref], [])].join('\n\n');
// The version a release commit's subject names, or null when subject isn't one.
export const releaseVersion = (subject) => /^chore\(release\): (\S+)$/.exec(subject)?.[1] ?? null;

// A squash merge's body, below the PR title as its subject: the PR's body as the detail, then the trailers, "Refs: <ref>"
// and each Co-Authored-By the PR's commits carry, once whatever its case. commits are gh's ({messageBody}).
export const squashBody = (ref, detail, commits) => withTrailers(detail, [ref], commits.map((c) => c.messageBody));

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
// that first subject; the first commit's detail, its Refs and Co-Authored-By lines left out; then the trailer block,
// "Refs: <ref>" (with no ref, each Refs the messages carry, once) and each Co-Authored-By they carry, once.
export function squashMessage(messages, { ref, title } = {}) {
  const [subject, ...body] = messages[0].split('\n');
  const detail = body.filter((l) => !REFS.test(l) && !COAUTHOR.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
  const refs = ref ? [ref] : once(messages.flatMap((m) => m.split('\n').filter((l) => REFS.test(l)).map((l) => l.replace(REFS, '').trim())));
  return [title ?? subject, withTrailers(detail, refs, messages)].filter(Boolean).join('\n\n');
}
