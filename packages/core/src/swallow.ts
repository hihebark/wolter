// Runs a storage call whose failure must never reach the host app — catches
// both a synchronous throw (better-sqlite3: disk full, SQLITE_BUSY, closed
// handle) and an async driver's rejected promise. Needed anywhere a call runs
// outside Recorder's try/catch, i.e. from a timer: an uncaught throw in a
// setInterval callback, or an unhandled rejection, crashes the process by
// default on Node >= 15 — the opposite of the zero-impact guarantee.
export function swallow(fn: () => unknown): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Zero-impact guarantee.
  }
}
