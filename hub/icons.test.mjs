import test from 'node:test';
import assert from 'node:assert/strict';
import { siteIcon, ICONS } from './icons.mjs';

const drawn = (html) => /data-icon="([a-z]+)"/.exec(html)?.[1] ?? null;

test('a manifest icon key wins over the route and title', () => {
  const html = siteIcon('backend-audit', { title: 'Backend Audit', icon: 'book', color: '#8b5cf6' });
  assert.equal(drawn(html), 'book');
  assert.ok(html.includes(ICONS.book));
  assert.match(html, /--c:#8b5cf6/);
});

test('without a key, the route and title pick the icon', () => {
  assert.equal(drawn(siteIcon('ios-orchestrator', { title: 'iOS Orchestrator', icon: '📱' })), 'phone');
  assert.equal(drawn(siteIcon('backend-audit', { title: 'Backend Audit' })), 'audit');
  assert.equal(drawn(siteIcon('learn', { title: 'Sync V2.1 course' })), 'book');
});

test('a site no keyword fits gets its title letter', () => {
  const html = siteIcon('zz', { title: 'zebra notes', icon: 'unicorn' });
  assert.equal(drawn(html), null);
  assert.match(html, /class="icon letter"[^>]*>Z<\/span>$/);
});
