// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
// The hub's look at each board's incoming PRs, run with its GitHub check. For each board with auto_review on and a
// repo on GitHub, it lists the repo's open PRs and writes data/incoming.json {at, repo, prs} with those from others
// that touch a file one of the board's cards changed, or that ask the owner for review. The board server wakes its
// session with pr-review for them one at a time (board/auto-review.mjs). A merged card PR's files never change, so
// they are kept in ~/.claude/kickflip/incoming-files.json by repo#pr; any other card PR's files are read each time.
import fs from 'node:fs';
import path from 'node:path';
import { INCOMING_FILES, listBoards, readJSON, saveJSON } from './boards.mjs';
import { openPRs, prFiles, githubLogin } from './pr-report.mjs';
import { cardPRs, storedPRs } from '../shared/card-prs.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// open: the repo's open PRs [{number, title, author, url, head, draft, files, requested}]; cards: each PR in the repo on
// the board's cards [{key, pr, files}], a card with several having an entry for each; me: the owner's GitHub login. → [{number, title, author, url, head, touches: [card key], asked}]
export function incomingFor({ open, cards, me }) {
  const ours = new Set(cards.map((c) => c.pr));
  return open.filter((p) => !p.draft && !same(p.author, me) && !ours.has(p.number)).map((p) => {
    const files = new Set(p.files);
    const touches = [...new Set(cards.filter((c) => c.files.some((f) => files.has(f))).map((c) => c.key))];
    const asked = p.requested.some((login) => same(login, me));
    return touches.length || asked ? { number: p.number, title: p.title, author: p.author, url: p.url, head: p.head, touches, asked } : null;
  }).filter(Boolean);
}

function writeIncoming(dir, value) {
  const file = path.join(dir, 'data', 'incoming.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// gh {openPRs(repo), prFiles(repo, number) → {state, files}} and login() → the gh account, for a board with no
// github_login; tests pass their own. → {checked: [route], failed: [message]}
export async function checkIncoming({ manifest, gh = { openPRs, prFiles }, login = githubLogin }) {
  const cache = readJSON(INCOMING_FILES, {});
  const checked = [];
  const failed = [];
  let fallback;
  for (const board of listBoards(manifest).filter((b) => b.auto_review && b.github)) {
    try {
      const me = board.githubLogin || (fallback ??= await login());
      const open = await gh.openPRs(board.github);
      const byNumber = new Map(open.map((p) => [p.number, p]));
      const cards = [];
      for (const { slug, itemFile } of board.files) {
        for (const it of itemFile.items.filter((i) => i && (i.lane !== 'done' || storedPRs(i).some((p) => p.merged_at)))) {
          for (const { number } of cardPRs(it, board.github).filter((p) => p.repo === board.github)) {
            const key = `${board.github}#${number}`;
            let files = byNumber.get(number)?.files || cache[key];
            if (!files) {
              const read = await gh.prFiles(board.github, number);
              files = read.files;
              if (read.state === 'MERGED') cache[key] = files;
            }
            cards.push({ key: `${slug}/${it.id}`, pr: number, files });
          }
        }
      }
      writeIncoming(board.dir, { at: new Date().toISOString(), repo: board.github, prs: incomingFor({ open, cards, me }) });
      checked.push(board.route);
    } catch (e) { failed.push(`${board.route}: ${e.message}`); }
  }
  saveJSON(INCOMING_FILES, cache);
  return { checked, failed };
}
