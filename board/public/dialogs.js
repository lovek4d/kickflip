// Every board page's dialogs go through these two, so a custom dialog can replace the native one here
// (docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md). Load it before any page script that asks.
(function () {
  const confirm = (message) => Promise.resolve(window.confirm(message));
  const notice = (message) => { window.alert(message); return Promise.resolve(); };
  globalThis.BoardDialogs = { confirm, notice };
})();
