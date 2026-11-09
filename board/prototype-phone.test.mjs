import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const read = (file) => fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8');

test('at phone width every box in the stage is capped to the stage, so a fixed-width panel stacks and is not cut off', () => {
  assert.match(read('prototype.html'), /@media \(max-width: 599px\) \{\s*#stage :where\([^)]*div[^)]*\)[^{]*\{[^}]*max-width: 100%[^}]*min-width: 0/);
});

// docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md
test('the viewer bar is a full-width footer on the bottom edge at every width, and the page above it ends at the footer\'s measured height', () => {
  const js = read('prototype-switcher.js');
  assert.match(js, /\n\.ps-switch \{[^}]*left:0; right:0; bottom:var\(--app-bottom, 0px\)/);
  assert.match(js, /\n\.ps-pill \{[^}]*border-radius:0/);
  assert.match(js, /setProperty\('--ps-footer-h'/);
  const page = read('prototype.html');
  assert.doesNotMatch(page, /@media \(max-width: 899px\) \{\s*(main\.proto-main|\.kit-served)/);
  assert.match(page, /main\.proto-main \{[^}]*padding-bottom: calc\(var\(--ps-footer-h, 150px\) \+ var\(--app-bottom, 0px\)\)/);
  const served = page.match(/\n  \.kit-served \{[^}]*\}/)?.[0] ?? '';
  assert.match(served, /height: calc\(100dvh - 60px - var\(--ps-footer-h, 150px\) - var\(--app-bottom, 0px\) - env\(safe-area-inset-top\)\)/);
  // The footer's measured height already includes its bottom inset, so neither subtracts the inset again.
  assert.doesNotMatch(served, /safe-area-inset-bottom/);
  assert.doesNotMatch(page.match(/main\.proto-main \{[^}]*\}/)?.[0] ?? '', /safe-area-inset-bottom/);
  // In the board's right pane there is no ✕ row above the page, so the frame runs from the top to the footer.
  assert.match(page, /\.ps-pane \.kit-served \{ height: calc\(100dvh - var\(--ps-footer-h, 150px\)\); \}/);
});

test('the viewer footer and Round pill stay hidden until the first load settles, then show once', () => {
  const js = read('prototype-switcher.js');
  assert.match(js, /\.ps-pending \{ visibility:hidden; \}/);
  assert.match(js, /box\.classList\.add\('ps-pending'\)/);
  assert.match(js, /try \{ await fetchQuestion\(\); \} finally \{ reveal\(\); \}/);
  assert.match(js, /box\.classList\.remove\('ps-pending'\);\s*top\.classList\.remove\('ps-pending'\)/);
});

test('the viewer note field is at least 16px, so iOS Safari does not zoom on focus', () => {
  const rule = read('prototype-switcher.js').match(/\.ps-switch \.ps-text \{[^}]*\}/)?.[0] ?? '';
  const px = Number(rule.match(/font:\s*\d+\s+(\d+)px/)?.[1]);
  assert.ok(px >= 16, `font is ${px}px`);
});

test('every input, select and textarea in the stage is 16px', () => {
  assert.match(read('prototype.html'), /#stage :where\(input, select, textarea\) \{[^}]*font-size: 16px/);
});

// Loads the real prototype page at 390px in headless Chrome (an iframe, since a headless window is never narrower than 500px)
// with one made-up take, and reports where its panels landed.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TAKE = `
export const render = (stage) => {
  stage.innerHTML = '<style>'
    + '.g { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .f { display: flex; flex-wrap: nowrap; gap: 8px; }'
    + '.p { height: 120px; background: #345; } .mock { width: 720px; height: 160px; background: #543; }</style>'
    + '<div class="g"><div class="p" id="g1"></div><div class="p" id="g2"></div></div>'
    + '<div class="f"><div class="p" id="f1" style="flex:1"></div><div class="p" id="f2" style="flex:1"></div></div>'
    + '<div><div class="mock" id="mock"></div></div>';
};`;
const PROBE = `<script>addEventListener('load', () => setTimeout(() => {
  const box = (id) => document.getElementById(id).getBoundingClientRect();
  const mock = document.getElementById('mock');
  parent.postMessage(JSON.stringify({ gridStacked: box('g2').top >= box('g1').bottom, flexStacked: box('f2').top >= box('f1').bottom,
    mockWidth: mock.getBoundingClientRect().width, scrollWidth: document.documentElement.scrollWidth, innerWidth,
    mockScrolls: mock.parentElement.scrollWidth > mock.parentElement.clientWidth }), '*');
}, 800))</script>`;

// Serves the real prototype page, with header in its header slot and probe before </body>, and loads it at 390px in
// headless Chrome; → what the probe posted, parsed.
async function phoneProbe({ header = '', probe }) {
  const pub = fileURLToPath(new URL('./public/', import.meta.url));
  const data = { topic: 't', title: 't', takes: [{ key: 'A', label: 'A', src: 'prototypes/t/A.js', file: 'prototypes/t/A.js' }] };
  const page = fs.readFileSync(`${pub}prototype.html`, 'utf8').replace('{{prototypeTitle}}', 't').replace('{{prototypeHeader}}', header)
    .replace('{{prototypeData}}', JSON.stringify(data)).replace('</body>', `${probe}</body>`);
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/frame.html') return res.setHeader('content-type', 'text/html'), res.end('<body><iframe style="width:390px;height:800px;border:0" src="/page.html"></iframe><script>addEventListener("message", (e) => { const d = document.createElement("pre"); d.id = "probe"; d.textContent = e.data; document.body.append(d); })</script>');
    if (p === '/page.html') return res.setHeader('content-type', 'text/html'), res.end(page);
    if (p === '/prototypes/t/A.js') return res.setHeader('content-type', 'text/javascript'), res.end(TAKE);
    const file = path.join(pub, p);
    if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, ok));
  try {
    // Chrome under load can crash before it dumps the DOM, or exit non-zero at teardown after it has; its output is read either
    // way, and a run that returned no probe is run once more.
    let posted;
    for (let attempt = 0; attempt < 2 && !posted; attempt++) {
      const { stdout } = await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--window-size=390,900', '--virtual-time-budget=6000', '--dump-dom',
        `http://localhost:${server.address().port}/frame.html`], { encoding: 'utf8', timeout: 60000 }).catch((e) => ({ stdout: e.stdout || '' }));
      posted = /<pre id="probe">(.*?)<\/pre>/s.exec(stdout)?.[1];
    }
    assert.ok(posted, 'the page reported its layout');
    return JSON.parse(posted.replace(/&quot;/g, '"'));
  } finally { server.close(); }
}

test('at phone width a take that pairs panels with grid or a non-wrapping flex row stacks them, and a 720px mock scrolls in its box without cutting the page off', { skip: !fs.existsSync(CHROME) }, async () => {
  const got = await phoneProbe({ probe: PROBE });
  assert.equal(got.gridStacked, true, 'the grid pair stacks');
  assert.equal(got.flexStacked, true, 'the non-wrapping flex pair stacks');
  assert.equal(got.mockWidth, 720, 'the 720px mock keeps its width');
  assert.equal(got.mockScrolls, true, 'the mock scrolls inside its box');
  assert.ok(got.scrollWidth <= got.innerWidth, `the page is not cut off: ${got.scrollWidth} wide in ${got.innerWidth}`);
});

// The page's header bar is hidden, so nothing is below the footer: its bottom is the window's.
test('at phone width the viewer footer sits on the bottom edge with no gap below it, though the page has a hidden header bar', { skip: !fs.existsSync(CHROME) }, async () => {
  const probe = `<script>addEventListener('load', () => setTimeout(() => {
  parent.postMessage(JSON.stringify({ footerBottom: document.querySelector('.ps-switch').getBoundingClientRect().bottom, innerHeight,
    appBottom: getComputedStyle(document.documentElement).getPropertyValue('--app-bottom').trim() }), '*');
}, 800))</script>`;
  const got = await phoneProbe({ header: '<header class="top"><a class="back" href="./">Back</a></header>', probe });
  assert.equal(got.footerBottom, got.innerHeight, `the footer ends ${got.innerHeight - got.footerBottom}px above the bottom (--app-bottom: ${got.appBottom})`);
});
