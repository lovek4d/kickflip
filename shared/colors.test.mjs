import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./colors.css', import.meta.url), 'utf8');
const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
const light = css.slice(0, css.indexOf('@media'));

test('colors.css declares color-scheme in both themes', () => {
  assert.match(light, /color-scheme:\s*light/);
  assert.match(dark, /color-scheme:\s*dark/);
});

test('every scroller is thin with a transparent track and a theme-mixed thumb', () => {
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /scrollbar-color:\s*var\(--scroll-thumb\) transparent/);
  assert.match(css, /--scroll-thumb:\s*color-mix\(in srgb, var\(--muted\)[^;]*var\(--bg\)/);
  assert.match(css, /::-webkit-scrollbar-thumb:hover/);
});
