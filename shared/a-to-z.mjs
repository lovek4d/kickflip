// How every picker's options sort: A–Z by label, ignoring case and accents, numbers by value (build-2 before build-10).
export const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const aToZ = (items, label = (item) => item) => [...items].sort((a, b) => collator.compare(label(a), label(b)));
