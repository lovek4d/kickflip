// docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { joinOf } from '../hub/sessions.mjs';

const context = vm.createContext({ Date, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout, AbortController });
for (const file of ['ui-icon-text.js', 'ui.js', 'ui-header.js', 'ui-page-header.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const ui = context.BoardUI;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const plain = (v) => JSON.parse(JSON.stringify(v));

const SESSION = '3f9a1c7e-0b1d-4c55-9e2a-7d1f00aa1234';
const HUB = { command: 'tmux attach -t kickflip-hub-orchestrator', tmux: true };
const BG = { command: 'claude attach 3f9a1c7e', tmux: false };

test("a board's join command is the hub board's tmux session, else claude attach with the session id's first 8 characters, and none without a session", () => {
  assert.deepEqual(joinOf({ route: 'hub-orchestrator', hub: true, owner: { session: SESSION } }), HUB);
  assert.deepEqual(joinOf({ route: 'ios', owner: { session: SESSION } }), BG);
  assert.equal(joinOf({ route: 'ios', owner: null }), null);
  assert.equal(joinOf({ route: 'hub-orchestrator', hub: true, owner: {} }), null);
});

test("the join's state reads the server's link first, then the session's watcher, and a page's own wake as waking", () => {
  const st = (join, o) => ui.joinState(join, o);
  assert.equal(st(null, { watcher: 'running', link: 'online' }), 'none');
  assert.equal(st(null, { watcher: 'running', link: 'offline' }), 'none');
  assert.equal(st(BG, { watcher: 'asleep', link: 'offline' }), 'down');
  assert.equal(st(BG, { watcher: 'running', link: 'online' }), 'awake');
  assert.equal(st(BG, { watcher: 'running', link: 'reconnecting' }), 'awake');
  assert.equal(st(BG, { watcher: 'asleep', link: 'online' }), 'asleep');
  assert.equal(st(BG, { watcher: 'asleep', link: 'online', waking: true }), 'waking');
  assert.equal(st(BG, { watcher: 'waking', link: 'online' }), 'waking');
  assert.equal(st(BG, { watcher: 'starting', link: 'online' }), 'none');
  assert.equal(st(BG, { watcher: 'stopped', link: 'online' }), 'deaf');
});

test('an awake session shows its command with Copy and how to leave it running, by how it runs', () => {
  const hub = ui.joinSheet(HUB, 'awake');
  assert.match(hub, /<code[^>]*>tmux attach -t kickflip-hub-orchestrator<\/code>/);
  assert.match(hub, /data-join-copy/);
  assert.doesNotMatch(hub, /data-join-wake/);
  assert.match(text(hub), /Running/);
  assert.match(text(hub), /ctrl-b d leaves it running/);
  assert.match(text(hub), /\/exit ends the session; the hub wakes it on the next event\./);
  const bg = ui.joinSheet(BG, 'awake');
  assert.match(bg, /<code[^>]*>claude attach 3f9a1c7e<\/code>/);
  assert.match(text(bg), /← \(agent view\) or Ctrl\+Z \(shell\) leaves it running/);
  assert.doesNotMatch(text(bg), /ctrl-b/);
});

test('an asleep session shows its command greyed with Wake, and waking keeps the button with the standard spinner and no text', () => {
  const asleep = ui.joinSheet(BG, 'asleep');
  assert.match(asleep, /class="join-cmd asleep"/);
  assert.match(asleep, /<button[^>]*data-join-wake[^>]*>Wake<\/button>/);
  assert.doesNotMatch(asleep, /data-join-copy/);
  assert.match(text(asleep), /Asleep: it wakes when you open the board or an event lands\./);
  const waking = ui.joinSheet(BG, 'waking');
  assert.match(waking, /<button[^>]*data-join-wake[^>]*aria-busy="true"[^>]*disabled[^>]*><\/button>/);
  assert.match(waking, /aria-label="Waking"/);
  assert.doesNotMatch(waking, /data-join-copy/);
});

test('with the server down the sheet keeps the saved command with Copy and has no Wake', () => {
  const down = ui.joinSheet(BG, 'down');
  assert.match(down, /<code[^>]*>claude attach 3f9a1c7e<\/code>/);
  assert.match(down, /data-join-copy/);
  assert.doesNotMatch(down, /Wake/);
  assert.match(text(down), /Server not answering/);
  assert.match(text(down), /From the saved copy/);
});

test('a board with no session yet shows no command, and one not listening keeps the command with Copy', () => {
  const none = ui.joinSheet(null, 'none');
  assert.doesNotMatch(none, /<code/);
  assert.doesNotMatch(none, /data-join-copy|data-join-wake/);
  assert.match(text(none), /No session yet/);
  const deaf = ui.joinSheet(BG, 'deaf');
  assert.match(deaf, /data-join-copy/);
  assert.match(text(deaf), /Not listening/);
});

test("the board menu's Join in terminal row carries the session's state as a coloured dot and word", () => {
  const row = (state) => ui.boardMenu(state);
  assert.match(row('awake'), /role="menuitem"[^>]*data-join-open/);
  assert.match(row('awake'), /it-green[\s\S]*Running/);
  assert.match(row('asleep'), /it-grey[\s\S]*Asleep/);
  assert.match(row('waking'), /it-orange[\s\S]*Waking/);
  assert.match(row('down'), /it-red[\s\S]*Not answering/);
  assert.match(row('deaf'), /it-red[\s\S]*Not listening/);
  assert.match(row('none'), /it-grey[\s\S]*No session yet/);
  assert.deepEqual(plain(Object.keys(ui.JOIN_STATES).sort()), ['asleep', 'awake', 'deaf', 'down', 'none', 'waking']);
});

test("a header with a title menu draws the title as the menu's button, its text still the title", () => {
  const h = ui.header({ title: 'Hub <Orchestrator>', titleMenu: '<div id="boardMenu" role="menu" hidden></div>' });
  assert.match(h, /<h1><button type="button" class="title-menu" id="boardMenuOpen" aria-haspopup="menu" aria-expanded="false" aria-controls="boardMenu">Hub &lt;Orchestrator&gt;<\/button><\/h1>/);
  assert.match(h, /<div id="boardMenu" role="menu" hidden><\/div>/);
  assert.match(ui.header({ title: 'Plain' }), /<h1>Plain<\/h1>/);
});

// docs/adr/2026-11-17-1800-the-board-menu-holds-settings-repo-review-and-pause.md
test("the board menu lists Join in terminal, Repo review, Pause and Settings in that order, Settings the link the shell opens as Board Settings", () => {
  const menu = ui.boardMenu('awake', { settings: true, arch: { running: false, at: '2026-11-12T10:00:00.000Z' }, pause: { paused: false } });
  assert.deepEqual(plain([...menu.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1])), ['Join in terminal', 'Repo review', 'Pause', 'Settings']);
  assert.match(menu, /<a role="menuitem" class="board-menu-item" href="settings\.html" id="settingsLink" aria-haspopup="dialog">/);
  assert.match(menu, /data-arch-sheet[\s\S]*it-grey[\s\S]*Last review Nov 12/);
  assert.match(menu, /data-pause-open[\s\S]*it-green[\s\S]*Running/);
  assert.doesNotMatch(menu, /chev|›/);
});

test("the menu's Settings is greyed until the header's controls are on, Repo review is absent without a repo and reads Running in orange while a review runs", () => {
  assert.match(ui.boardMenu('awake', { settings: false }), /id="settingsLink"[^>]*aria-disabled="true" tabindex="-1"/);
  assert.doesNotMatch(ui.boardMenu('awake', { settings: true }), /aria-disabled|Repo review/);
  assert.match(ui.boardMenu('awake', { arch: { running: true, at: '2026-11-12T10:00:00.000Z' } }), /Repo review[\s\S]*it-orange[\s\S]*Running/);
  assert.match(ui.boardMenu('awake', { arch: { running: false } }), /No review yet/);
});

test("the menu's pause row becomes Resume in grey while the owner's Pause board holds, and shows another pause without a way to end it", () => {
  const mine = ui.boardMenu('awake', { pause: { paused: true, mine: true, words: 'until 6 pm' } });
  assert.match(mine, /data-pause-resume[\s\S]*Resume[\s\S]*it-grey[\s\S]*Paused until 6 pm/);
  assert.doesNotMatch(mine, /data-pause-open/);
  const hub = ui.boardMenu('awake', { pause: { paused: true, mine: false, words: 'until you resume' } });
  assert.match(hub, /aria-disabled="true" disabled[\s\S]*it-grey[\s\S]*Paused until you resume/);
  assert.doesNotMatch(hub, /data-pause-resume|data-pause-open/);
});
