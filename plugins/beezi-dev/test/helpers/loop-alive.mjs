// Node 18/22 compatibility shim for tests that await a deliberately-stalled fake.
//
// Several modules bound a wait with a timer they `unref()` on purpose — lib/http.mjs's
// `readJsonBounded` abandon timer, lib/mcp-bridge.mjs's sign-in grace timer. The rule those timers
// encode is "never be the reason the process stays up", and in production they never are: a body
// that stalls mid-read is stalling on a real socket, and the bridge is holding stdin open. Both are
// ref'd handles, so the loop stays alive and the unref'd timer fires.
//
// A test replaces that socket with `json: () => new Promise(() => {})`, which holds nothing. The
// unref'd timer is then the ONLY handle left, so Node's event loop drains before it can fire. On
// Node 18 and 22 the test runner reports that as `cancelledByParent` with "Promise resolution is
// still pending but the event loop has already resolved", and every later test in the file cascades
// off it; Node 24's runner keeps a handle of its own alive and hides the difference.
//
// `withLoopAlive` stands in for the handle the fake removed — nothing more. It does not shorten,
// lengthen or bypass any bound: the timer under test still has to fire on its own budget for the
// assertions to pass, which is why the wrap is around the awaited call and not the whole test.
export async function withLoopAlive(fn) {
  // Ref'd on purpose. Cleared in `finally` so a failed assertion cannot leave it holding the
  // process open for the rest of the run.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}
