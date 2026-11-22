// The checks every board command makes on what it is given, and BoardError, the refusal they throw: a command's
// words refused name what it takes. Each concept module of the board's data (cards, questions, asks, settings, runs)
// checks its input with these (docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md).
import { cardTitleFault, cardTitleWords } from './commit-message.mjs';

// brief, when a refusal has one, is its reason in a status line's room, for the line a refusal the board meets writes
// (hub-lines.mjs build-refused); the message is whole.
export class BoardError extends Error {
  constructor(message, brief) {
    super(message);
    this.brief = brief;
  }
}
export const fail = (msg, brief) => { throw new BoardError(msg, brief); };

export const needSite = (site) => site || fail('this command needs --site <route>');
export const text = (v, name) => (typeof v === 'string' && v.trim() ? v.trim() : fail(`${name} must be non-empty text`));
export const optional = (v, check) => (v === undefined ? undefined : check(v));
// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a --title a card takes is a Conventional subject or an ask.
export const cardTitle = (v) => {
  const title = text(v, '--title');
  const fault = cardTitleFault(title);
  return fault ? fail(`--title "${title}" ${fault}; a task's title is ${cardTitleWords}`) : title;
};
export const PROTOTYPE_PAGE = /^prototype-[\w-]+\.html(?:[?#]\S*)?$/;
export const VISUAL_PAGE = /^visuals\/[\w-]+\/[\w-]+\.html$/;
export const pageUrl = (v, name) => (typeof v === 'string' && (PROTOTYPE_PAGE.test(v) || VISUAL_PAGE.test(v) || /^https?:\/\/\S+$/.test(v)) ? v : fail(`${name} must be an http(s) URL or a site page such as prototype-<topic>.html?q=<id>`));
export const bool = (v, name) => (typeof v === 'boolean' ? v : fail(`${name} must be true or false`));
export const domId = (v, name) => (typeof v === 'string' && /^[\w.-]+$/.test(v) ? v : fail(`${name} must use only letters, digits, "_", "." and "-"`));
export const onlyKeys = (o, keys, name) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${name} must be a JSON object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) fail(`${name} has unknown field ${extra.map((k) => `"${k}"`).join(', ')}; allowed: ${keys.join(', ')}`);
};
