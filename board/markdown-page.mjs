// A Markdown report as a self-contained visual page (runs.mjs addVisual). The body is drawn by the renderer the board's
// notes use, public/ui-markdown.js, loaded here with the two helpers it takes from the browser's BoardUI.
// docs/adr/2026-11-18-2345-a-report-for-the-owner-goes-to-a-visual-never-a-local-path.md
import fs from 'node:fs';
import vm from 'node:vm';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BoardUI = { esc, linkHtml: (html) => html, opensHere: (href) => !/^[a-z][\w+.-]*:/i.test(href) };
const sandbox = { BoardUI };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(new URL('./public/ui-markdown.js', import.meta.url), 'utf8'), sandbox);

const STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1c1c1e; --muted: #6b6b70; --line: #d8d8dc; --code: #f1f1f4; --link: #0a60d0; }
@media (prefers-color-scheme: dark) { :root { --bg: #151517; --fg: #ececf0; --muted: #9a9aa2; --line: #36363b; --code: #232327; --link: #6aa8ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 -apple-system, system-ui, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 20px 16px 48px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
h1 { font-size: 1.6em; margin-top: 0; }
a { color: var(--link); }
code { background: var(--code); border-radius: 4px; padding: .1em .35em; font: .9em ui-monospace, Menlo, monospace; }
pre { background: var(--code); border-radius: 8px; padding: 12px; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin: 1em 0; padding: 0 14px; border-left: 3px solid var(--line); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.6em 0; }
.md-table { overflow-x: auto; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--code); }
li.nested { margin-left: 1.4em; }
`;

// → the page's HTML for Markdown source md, titled title.
export function markdownPage(md, title) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>\n${sandbox.BoardUI.markdown(md)}\n</main></body></html>\n`;
}
