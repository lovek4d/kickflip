// The header's bulb and its review sheet: the board's last architecture review and Run, which confirms and asks the
// board server to start one (docs/adr/0125-the-bulb-runs-an-architecture-review-of-the-boards-repo.md). The bulb glows
// while a review runs. Needs app-core.js.
BoardView.part((B) => {
  const { $, state } = B;
  const { esc, LINK_ARROW } = BoardUI;
  const bulb = $('#archBulb');
  const sheet = $('#archSheet');
  const day = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  let starting = false;

  function body(a) {
    const last = a.last;
    if (last?.running) {
      return `<p>Reviewing ${esc(a.repo)} since ${esc(BoardUI.time(last.at))}. The bulb glows until its wave is ready.</p>`
        + `<button type="button" class="arch-run" data-arch-open="${esc(last.key)}">Open ${esc(last.ref)}</button>`;
    }
    const lastHtml = last ? `<div class="arch-last"><span>Last review: <b>${esc(last.wave)}</b> · ${esc(day(last.at))}</span>`
      + `<span class="muted">${B.plural(last.findings, 'finding')}, ${last.built} built · <a href="#item=${encodeURIComponent(last.key)}" data-arch-open="${esc(last.key)}">${esc(last.ref)} ${LINK_ARROW}</a></span></div>` : '';
    const waits = a.waits ? `<p class="arch-waits" role="status">${esc(a.waits)}</p>` : '';
    return `${lastHtml}${waits}<button type="button" class="primary arch-run" data-arch-run${a.waits || starting ? ' disabled' : ''}>${starting ? 'Starting…' : `Run a review of ${esc(a.repo)}`}</button>`
      + '<p class="muted">Claude reads the repo and makes a wave. Its first card asks you one question per finding.</p>';
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
    const hash = `#item=${encodeURIComponent(key)}`;
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  }

  async function run() {
    const a = state.board?.arch;
    if (!a || a.waits || starting) return;
    if (a.last?.open) { openCard(a.last.key); B.toast(`${a.last.ref} is this board’s open review.`); return; }
    sheet.close();
    if (!(await B.confirm(`Claude reads ${a.repo} and makes a wave whose first card asks you one question per finding. Run the architecture review?`)) || !B.alive()) return;
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
    sheet.showModal();
  });
  B.on(sheet, 'click', (ev) => {
    if (ev.target === sheet || ev.target.closest('#archClose')) { sheet.close(); return; }
    const open = ev.target.closest('[data-arch-open]');
    if (open) { ev.preventDefault(); openCard(open.dataset.archOpen); return; }
    if (ev.target.closest('[data-arch-run]')) run();
  });

  Object.assign(B, { renderArch });
});
