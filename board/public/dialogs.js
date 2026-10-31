// Native confirmations cannot label their actions on iOS; labelled confirmations use a modal sheet.
// Load before any page script that asks (docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md).
(function () {
  let close = null;
  function sheet(message, { ok, cancel = 'Cancel', signal }) {
    close?.(false);
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const el = document.createElement('dialog');
      el.setAttribute('class', 'confirm-sheet');
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'confirmSheetText');
      el.innerHTML = '<div class="box"><p id="confirmSheetText"></p><button type="button" data-answer="ok"></button></div>'
        + '<div class="box"><button type="button" class="cancel" data-answer="cancel"></button></div>';
      el.querySelector('p').textContent = message;
      el.querySelector('[data-answer="ok"]').textContent = ok;
      el.querySelector('[data-answer="cancel"]').textContent = cancel;
      let settled = false;
      const abort = () => done(false);
      function done(yes) {
        if (settled) return;
        settled = true;
        close = null;
        signal?.removeEventListener('abort', abort);
        el.close();
        el.remove();
        if (previous?.isConnected) previous.focus();
        resolve(yes);
      }
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-answer]');
        if (b || e.target === el) done(b?.dataset.answer === 'ok');
      });
      el.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      el.addEventListener('close', () => done(false));
      signal?.addEventListener('abort', abort, { once: true });
      document.body.appendChild(el);
      el.showModal();
      el.querySelector('.cancel').focus();
      close = done;
    });
  }
  function fitSheet(sheet) {
    const vv = window.visualViewport;
    // iOS keeps fixed elements on the layout viewport; --kb is the part covered by its keyboard.
    const fit = () => {
      const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      sheet.style.setProperty('--kb', kb + 'px');
      sheet.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');
      sheet.classList.toggle('kb', kb > 0);
    };
    sheet.classList.add('keyboard-sheet');
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    return () => {
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
    };
  }
  const confirm = (message, labels) => (labels?.signal?.aborted ? Promise.resolve(false)
    : labels?.ok ? sheet(message, labels) : Promise.resolve(window.confirm(message)));
  const notice = (message) => { window.alert(message); return Promise.resolve(); };
  globalThis.BoardDialogs = { confirm, notice, fitSheet };
})();
