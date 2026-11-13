// docs/adr/2026-11-13-1417-ui-tests-freeze-date-in-their-sandbox.md
// A test's fixed clock. fixedDate(clock) is a Date whose new Date() and Date.now() read clock(), and which otherwise is
// the real Date: a UI test hands one to the sandbox its page scripts run in, so every renderer counts to the test's time.
// Loaded by `node --import` with KICKFLIP_TEST_NOW set to a time in ms, it fixes the process's own Date there, for a
// test that runs a script as a child.
export const fixedDate = (clock) => class extends Date {
  constructor(...args) { super(...(args.length ? args : [clock()])); }
  static now() { return clock(); }
};

if (process.env.KICKFLIP_TEST_NOW) {
  const at = Number(process.env.KICKFLIP_TEST_NOW);
  globalThis.Date = fixedDate(() => at);
}
