// The header controls on pages other than the board itself, which app-header.js wires.
(function () {
  // Refresh reloads the page, and refresh and the gear turn on together once `ready` has settled.
  async function wire({ ready = Promise.resolve() } = {}) {
    const refresh = document.getElementById('refresh');
    refresh.addEventListener('click', () => { refresh.disabled = true; refresh.classList.add('spinning'); location.reload(); });
    await Promise.resolve(ready).catch(() => {});
    refresh.disabled = false;
    refresh.classList.remove('spinning');
    const gear = document.getElementById('settingsLink');
    gear.removeAttribute('aria-disabled');
    gear.removeAttribute('tabindex');
  }

  globalThis.PageHeader = { wire };
})();
