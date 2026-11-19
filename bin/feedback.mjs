// kickflip feedback: the GitHub new-issue form with the type, title and versions filled in.
// Only the versions go in the URL; no board, path or host does.
import os from 'node:os';

export const FEEDBACK_TYPES = ['bug', 'idea', 'question'];
const NEW_ISSUE = 'https://github.com/lovek4d/kickflip/issues/new';

export function versionsLine(kickflip) {
  return `kickflip ${kickflip}, node ${process.versions.node}, ${os.type()} ${os.release()} ${os.arch()}`;
}

export function feedbackUrl({ type, title, versions }) {
  const q = new URLSearchParams({ template: 'feedback.yml' });
  if (title) q.set('title', title);
  if (type) q.set('type', type);
  q.set('versions', versions);
  return `${NEW_ISSUE}?${q}`;
}
