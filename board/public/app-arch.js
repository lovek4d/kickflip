// The bulb at the foot of the board and its review sheet: the board's last architecture review and Run, which confirms and asks the
// board server to start one (docs/adr/2026-11-02-1813-the-bulb-runs-an-architecture-review-of-the-boards-repo.md). The bulb glows
// while a review runs. Needs app-core.js.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc } = BoardUI;
  const bulb = $('#archBulb');
  const sheet = $('#archSheet');
  const day = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  let starting = false;

  function body(a) {
    const last = a.last;
    if (last?.running) {
      return `<p>Reviewing ${esc(a.repo)} since ${esc(BoardUI.time(last.at))}. The bulb glows until its findings are ready.</p>`
        + `<button type="button" class="arch-run" data-arch-open="${esc(last.key)}">Open ${esc(last.ref)}</button>`;
    }
    const lastHtml = last ? `<div class="arch-last"><span>Last review: <b>${esc(last.title)}</b> · ${esc(day(last.at))}</span>`
      + `<span class="muted">${B.plural(last.findings, 'finding')}, ${last.built} built · ${BoardUI.taskLink(last.key, last.ref, state.board.items.find((i) => i.key === last.key)?.lane, { attrs: ` data-arch-open="${esc(last.key)}"` })}</span></div>` : '';
    const waits = a.waits ? `<p class="arch-waits" role="status">${esc(a.waits)}</p>` : '';
    return `${lastHtml}${waits}<button type="button" class="primary arch-run" data-arch-run${starting ? BoardUI.BUSY : a.waits ? ' disabled' : ''}>Run a review of ${esc(a.repo)}</button>`
      + '<p class="muted">Claude reads the repo and makes a review task that asks you one question per finding.</p>';
  }

  function renderArch(d) {
    const a = d.arch;
    bulb.hidden = !a;
    const running = Boolean(a?.last?.running);
    bulb.classList.toggle('running', running);
    const label = running ? 'Architecture review running' : 'Architecture review';
    bulb.setAttribute('aria-label', label);
    bulb.title = label;
    if (sheet.open && a) $('#archBody').innerHTML = body(a);
    if (sheet.open && !a) sheet.close();
  }

  function openCard(key) {
    sheet.close();
    const hash = `#selectedCard=${encodeURIComponent(key)}`;
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  }

  async function run() {
    const a = state.board?.arch;
    if (!a || a.waits || starting) return;
    if (a.last?.open) { openCard(a.last.key); B.toast(`${a.last.ref} is this board’s open review.`); return; }
    sheet.close();
    if (!(await B.confirm(`Claude reads ${a.repo} and makes a review task that asks you one question per finding. Run the architecture review?`)) || !B.alive()) return;
    starting = true;
    try {
      const r = await fetch(B.site.url('api/arch-review'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const answer = await r.json().catch(() => ({}));
      if (!r.ok) { B.notice(answer.error || 'Could not start the review. Is the host awake?'); return; }
      if (answer.existing) { openCard(answer.key); B.toast(`${answer.ref} is this board’s open review.`); return; }
      await B.loadBoard();
    } catch { B.notice('Could not start the review. Is the host awake?'); }
    finally { starting = false; if (state.board) renderArch(state.board); }
  }

  B.on(bulb, 'click', () => {
    const a = state.board?.arch;
    if (!a || sheet.open) return;
    $('#archBody').innerHTML = body(a);
    BoardUI.openSheet(sheet);
  });
  B.atUnmount(BoardUI.swipeToDismiss(sheet));
  B.on(sheet, 'click', (ev) => {
    if (BoardUI.onBackdrop(ev, sheet) || ev.target.closest('#archClose')) { sheet.close(); return; }
    const open = ev.target.closest('[data-arch-open]');
    if (open) { ev.preventDefault(); openCard(open.dataset.archOpen); return; }
    if (ev.target.closest('[data-arch-run]')) run();
  });

  Object.assign(B, { renderArch });
});
