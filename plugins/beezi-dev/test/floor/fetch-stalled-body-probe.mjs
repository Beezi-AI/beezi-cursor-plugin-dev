// Standalone stalled-body probe for the declared Node 13.2 floor (M10 floor job).
//
// WHY THIS IS NOT A `node:test` FILE. The floor job runs a real Node 13.2, which has no test
// runner, no `node:` import prefix in ESM (that needs 12.20/14.13.1+ and would fail at IMPORT,
// not at assert), no global `AbortController` and no global `fetch`. Every one of those is
// exactly the reason `lib/fetch-compat.mjs` and `lib/abort-compat.mjs` exist, so the one place
// their abort-through-the-body behaviour must be demonstrated is the interpreter that actually
// uses them. The regular suite covers the same ground on the modern runtime; this file is the
// floor's copy and is deliberately written to the floor's syntax:
//
//   bare `http` import, no `node:` prefix   no top-level await        no optional chaining
//   no nullish coalescing                    no numeric separators     no class fields
//
// It is ALSO picked up by `node --test` (everything under `test/` is), which is intentional:
// a probe that silently rots is worse than no probe. It prints nothing on success and exits 0.
//
// Run directly:  node test/floor/fetch-stalled-body-probe.mjs
//
// ── WHAT THIS ASSERTS, AND WHY NOT `res.destroyed` ──────────────────────────────────────────────
//
// The first version of this probe asserted `res.body.destroyed === true` after the abort. That
// passes on modern Node and FAILS on 13.2 — and the failure was in the assertion, not in the shim.
// Measured on both interpreters, immediately after `IncomingMessage.destroy()`:
//
//                        Node 13.2          Node 24
//   res.destroyed        false              true
//   res.aborted          false              true
//   socket.destroyed     TRUE               TRUE
//
// On 13.2 `IncomingMessage.prototype.destroy()` tears down the underlying SOCKET but never flags
// the message object itself; `destroyed` moving onto the IncomingMessage came later. So the old
// assertion measured a version-specific bookkeeping field rather than the thing that matters, and
// on the floor it reported a healthy teardown as a defect.
//
// What matters is that the abort actually frees the connection, so this probe now asserts the
// three invariants that say so and that hold identically on 13.2 and on 24:
//
//   1. the pending body read rejects with an AbortError, promptly;
//   2. the socket that was carrying the response is destroyed;
//   3. the server then closes cleanly WITHOUT the probe hand-destroying any connection, and the
//      socket is gone from the process's active handles by the time it has.
//
// (3) is the real subject of "process exit without an open response handle", and it is STRICTER
// than what was there before: `server.close()` does not complete while a connection is still open,
// so a shim that left the socket alive hangs here and the watchdog reports it, rather than sailing
// past a boolean. Two details that cost a debugging round each:
//
//   * the active-handle check is by OBJECT IDENTITY, not by count — Node 13.2 on Windows holds two
//     Socket handles at idle (stdout/stderr), so a count proves nothing;
//   * and it runs AFTER `server.close()` completes, not immediately after the abort. `destroyed`
//     flips synchronously but libuv releases the handle a tick or more later, so an eager check
//     fails on 13.2 AND on 24 while the teardown is in fact perfectly healthy.
import http from 'http';
import { httpsFetch } from '../../lib/fetch-compat.mjs';
import { resolveAbortController } from '../../lib/abort-compat.mjs';

// Generous next to the ~10ms the abort actually takes, tight enough that a REGRESSION — the
// promise never settling, which is the whole failure being probed — fails the job instead of
// hanging the floor runner until CI kills it.
var SETTLE_BUDGET_MS = 5000;

function fail(message) {
  var err = new Error(message);
  err.name = 'ProbeFailure';
  return err;
}

function check(condition, message) {
  if (!condition) throw fail(message);
}

// A server that sends response HEADERS and a partial JSON body and then never ends it.
//
// `stop()` deliberately does NOT destroy the connection itself. `server.close()` waits for open
// connections, so letting it run unaided is the assertion: if the abort did not free the socket,
// the close never completes and the watchdog below turns that into a failure.
function startStalledServer() {
  return new Promise(function (resolve) {
    var seen;
    var requestSeen = new Promise(function (r) { seen = r; });
    var server = http.createServer(function (req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
      seen();
    });
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port,
        requestSeen: requestSeen,
        stop: function () {
          return withinBudget(
            new Promise(function (done) { server.close(function () { done(true); }); }),
            'server.close() after the abort (a connection was left open)'
          );
        }
      });
    });
  });
}

// Rejects if `promise` has not settled inside the budget — an unbounded body read is precisely
// the bug, so "still pending" has to be a failure and not a wait.
function withinBudget(promise, what) {
  var timer;
  var expired = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      reject(fail(what + ' did not settle within ' + SETTLE_BUDGET_MS + 'ms'));
    }, SETTLE_BUDGET_MS);
  });
  return Promise.race([promise, expired]).then(
    function (value) { clearTimeout(timer); return value; },
    function (error) { clearTimeout(timer); throw error; }
  );
}

function expectAbort(promise, what) {
  return withinBudget(
    promise.then(
      function () { throw fail(what + ' resolved; an AbortError was required'); },
      function (error) {
        check(error && error.name === 'AbortError', what + ' rejected with ' + (error && error.name) + ', not AbortError');
        return true;
      }
    ),
    what
  );
}

// Asserted immediately after the abort: the socket carrying the response is torn down. This is the
// invariant that holds on every runtime, unlike the IncomingMessage's own `destroyed` flag.
function checkSocketDestroyed(socket, what) {
  check(socket != null, what + ': no socket was captured from the response');
  check(socket.destroyed === true, what + ': the socket carrying the response was left open after the abort');
}

// Asserted after `server.close()` has completed, by which point libuv has released the handle.
// Identity, not count: Node 13.2 on Windows holds two Socket handles at idle (stdout/stderr).
function checkSocketHandleGone(socket, what) {
  var handles = process._getActiveHandles();
  check(handles.indexOf(socket) === -1, what + ': the response socket is still an active handle after the close');
}

// Abort DURING the body read: the read is already in flight when the signal fires.
function probeAbortDuringBody(fixture) {
  var AbortControllerImpl = resolveAbortController();
  var controller = new AbortControllerImpl();
  var socket = null;
  return httpsFetch(fixture.url, { signal: controller.signal })
    .then(function (res) {
      check(res.status === 200, 'expected headers before the stall, got ' + res.status);
      socket = res.body.socket;
      var reading = expectAbort(res.json(), 'json() during a stalled body');
      return fixture.requestSeen.then(function () {
        controller.abort();
        return reading;
      });
    })
    .then(function () {
      checkSocketDestroyed(socket, 'abort during the body read');
      return socket;
    });
}

// Abort AFTER the headers but BEFORE anyone asks for the body: the read must reject at once
// rather than attaching handlers to a stream that is going nowhere.
function probeAbortBeforeBodyRead(fixture) {
  var AbortControllerImpl = resolveAbortController();
  var controller = new AbortControllerImpl();
  var res = null;
  var socket = null;
  return httpsFetch(fixture.url, { signal: controller.signal })
    .then(function (response) {
      res = response;
      socket = response.body.socket;
      return fixture.requestSeen;
    })
    .then(function () {
      controller.abort();
      return expectAbort(res.text(), 'text() on an already-aborted signal');
    })
    .then(function () {
      checkSocketDestroyed(socket, 'abort before the body read');
      return socket;
    });
}

// Each probe gets its own fixture: the first one's connection is gone and its `requestSeen` spent.
// The close is part of the assertion, not cleanup — see (3) at the top of this file.
function runProbe(probe, what) {
  var fixture;
  var socket = null;
  return startStalledServer()
    .then(function (started) {
      fixture = started;
      return probe(fixture);
    })
    .then(function (captured) {
      socket = captured;
      return fixture.stop();
    })
    .then(function () {
      checkSocketHandleGone(socket, what);
    }, function (error) {
      // Still close the server so a failure reports its own message rather than hanging the floor
      // job — but only after the real error has been captured, and never masking it.
      if (fixture == null) throw error;
      return fixture.stop().then(function () { throw error; }, function () { throw error; });
    });
}

function main() {
  return runProbe(probeAbortDuringBody, 'abort during the body read').then(function () {
    return runProbe(probeAbortBeforeBodyRead, 'abort before the body read');
  });
}

main().then(
  function () { process.exit(0); },
  function (error) {
    console.error('fetch stalled-body probe FAILED: ' + (error && error.message ? error.message : error));
    process.exit(1);
  }
);
