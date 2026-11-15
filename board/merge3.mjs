import { isDeepStrictEqual } from 'node:util';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// The field that names each record of a list: id, else key, when every record has it and none repeats.
const identityOf = (list) => ['id', 'key'].find((f) => Array.isArray(list) && list.every((e) => isObject(e) && typeof e[f] === 'string') && new Set(list.map((e) => e[f])).size === list.length);

// Three-way merge of JSON: base is what a writer read, mine is what it wants written, theirs is what the file holds now.
// Each side's changes to base are kept; where both changed the same value, mine wins. Arrays of objects with a unique id, else a unique key, merge per that field,
// keeping theirs' order with mine's additions last; any other array is one value.
export function merge3(base, mine, theirs) {
  if (isDeepStrictEqual(mine, base)) return theirs;
  if (isDeepStrictEqual(theirs, base)) return mine;
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      if (!(key in mine)) { if (!(key in base) || !isDeepStrictEqual(base[key], theirs[key])) out[key] = theirs[key]; continue; }
      if (!(key in theirs)) { if (!(key in base) || !isDeepStrictEqual(base[key], mine[key])) out[key] = mine[key]; continue; }
      out[key] = merge3(base[key], mine[key], theirs[key]);
    }
    return out;
  }
  const field = identityOf(mine);
  if (field && identityOf(base) === field && identityOf(theirs) === field) {
    const find = (list, id) => list.find((e) => e[field] === id);
    const merged = [];
    for (const t of theirs) {
      const b = find(base, t[field]);
      const m = find(mine, t[field]);
      if (!m) { if (!b || !isDeepStrictEqual(b, t)) merged.push(t); continue; }
      merged.push(b ? merge3(b, m, t) : m);
    }
    return [...merged, ...mine.filter((m) => !find(theirs, m[field]) && !find(base, m[field]))];
  }
  return mine;
}
