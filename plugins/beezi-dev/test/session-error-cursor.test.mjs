import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyToolFailure, classifyTurnError, SESSION_ERROR, ERROR_DETAILS_CAP,
} from '../lib/session-error-cursor.mjs';

// The code the server stores as `raw_error` and the portal shows, and the one line of text beside
// it. Every case here is a promise about what a support engineer will read.

const failure = (fields) => ({ hook_event_name: 'postToolUseFailure', tool_use_id: 't1', ...fields });

test('the eight codes are the ones the API PR displays', () => {
  assert.deepEqual(Object.values(SESSION_ERROR).sort(), [
    'agent_stalled', 'mcp_error', 'rate_limit', 'tool_error', 'tool_permission_denied',
    'tool_timeout', 'turn_error', 'user_aborted',
  ]);
});

test('a shell timeout reports tool_timeout with tool, kind and duration in front of the message', () => {
  assert.deepEqual(
    classifyToolFailure(failure({
      tool_name: 'Shell', failure_type: 'timeout', duration: 30000, error_message: 'Command timed out',
    })),
    { error: 'tool_timeout', errorDetails: 'Shell · timeout · 30.0s: Command timed out' },
  );
});

test('permission_denied reports tool_permission_denied, even on a file tool', () => {
  assert.deepEqual(
    classifyToolFailure(failure({ tool_name: 'Read', failure_type: 'permission_denied', error_message: 'Access denied' })),
    { error: 'tool_permission_denied', errorDetails: 'Read · permission_denied: Access denied' },
  );
});

test('a failure kind spelled with hyphens or spaces is the same kind', () => {
  // A host that writes `permission-denied` or `Permission Denied` means the documented
  // `permission_denied`; rejecting the separator filed it as `tool_error` with kind `unknown`.
  for (const failureType of ['permission-denied', 'Permission Denied']) {
    assert.deepEqual(
      classifyToolFailure(failure({ tool_name: 'Shell', failure_type: failureType, error_message: 'Access denied' })),
      { error: 'tool_permission_denied', errorDetails: 'Shell · permission_denied: Access denied' },
      failureType,
    );
  }
});

test('an interrupted call is not reported, whatever else it says', () => {
  assert.equal(
    classifyToolFailure(failure({ tool_name: 'Shell', failure_type: 'timeout', is_interrupt: true, error_message: 'x' })),
    null,
  );
});

test('an ordinary error on a file or search tool is noise and is skipped', () => {
  for (const tool of ['Read', 'read_file', 'StrReplace', 'Grep', 'Glob', 'codebase_search']) {
    assert.equal(
      classifyToolFailure(failure({ tool_name: tool, failure_type: 'error', error_message: 'ENOENT' })),
      null,
      tool,
    );
  }
  // An absent failure_type is the documented default, `error` — so a legacy payload skips the same way.
  assert.equal(classifyToolFailure(failure({ tool_name: 'Read', error_message: 'ENOENT' })), null);
});

test('a timeout on a file tool is still reported: only the ordinary error is noise', () => {
  assert.equal(classifyToolFailure(failure({ tool_name: 'Read', failure_type: 'timeout' })).error, 'tool_timeout');
});

test('an MCP error reports mcp_error under either naming', () => {
  const args = { failure_type: 'error', error_message: '502 Bad Gateway' };
  assert.equal(classifyToolFailure(failure({ tool_name: 'mcp_github_create_issue', ...args })).error, 'mcp_error');
  assert.equal(classifyToolFailure(failure({ tool_name: 'MCP:create_issue', ...args })).error, 'mcp_error');
});

test('shell, unknown tools and undocumented failure kinds report tool_error', () => {
  assert.equal(classifyToolFailure(failure({ tool_name: 'Shell', failure_type: 'error', error_message: 'exit 1' })).error, 'tool_error');
  assert.equal(classifyToolFailure(failure({ tool_name: 'SomethingNew', failure_type: 'error', error_message: 'x' })).error, 'tool_error');
  // Not the known-noisy `error`, so it is reported rather than skipped.
  assert.equal(classifyToolFailure(failure({ tool_name: 'Read', failure_type: 'crashed' })).error, 'tool_error');
});

test('with no message the details are built from the safe fields and are never empty', () => {
  assert.equal(classifyToolFailure(failure({ tool_name: 'Shell', failure_type: 'error' })).errorDetails, 'Shell failed (error)');
  assert.equal(classifyToolFailure(failure({ failure_type: 'timeout' })).errorDetails, 'Unknown tool failed (timeout)');
  assert.equal(classifyToolFailure(failure({ tool_name: 'Shell', error_message: '   ' })).errorDetails, 'Shell failed (error)');
});

test('duration arrives as a number or a numeric string; anything else is left out', () => {
  const at = (duration) => classifyToolFailure(failure({
    tool_name: 'Shell', failure_type: 'timeout', duration, error_message: 'm',
  })).errorDetails;
  assert.equal(at('1500'), 'Shell · timeout · 1.5s: m');
  assert.equal(at(-1), 'Shell · timeout: m');
  assert.equal(at('soon'), 'Shell · timeout: m');
});

test('tool_input never reaches errorDetails, whatever it holds', () => {
  const secret = 'sk-live-4f8a2b9c1d3e5f7a0b2c';
  const out = classifyToolFailure(failure({
    tool_name: 'Shell', failure_type: 'error', error_message: 'exit code 22',
    tool_input: { command: `curl -H "Authorization: Bearer ${secret}" https://api.example.dev` },
  }));
  assert.ok(!out.errorDetails.includes(secret), out.errorDetails);
  assert.ok(!out.errorDetails.includes('curl'), out.errorDetails);
});

test('the message is redacted before it is cut to the server cap', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const out = classifyToolFailure(failure({
    tool_name: 'Shell', failure_type: 'error', error_message: `${'.'.repeat(970)}${secret} rest of the log`,
  }));
  assert.ok(out.errorDetails.length <= ERROR_DETAILS_CAP, `${out.errorDetails.length}`);
  assert.ok(!out.errorDetails.includes('ghp_0123456789'), out.errorDetails.slice(-80));
  assert.ok(out.errorDetails.includes('[REDACTED]'));
});

test('the legacy field names are still read, after the documented one', () => {
  assert.equal(classifyToolFailure(failure({ tool_name: 'Shell', error: 'boom' })).errorDetails, 'Shell · error: boom');
  assert.equal(classifyToolFailure(failure({ tool_name: 'Shell', tool_output: 'out' })).errorDetails, 'Shell · error: out');
  assert.equal(
    classifyToolFailure(failure({ tool_name: 'Shell', error_message: 'documented', error: 'legacy' })).errorDetails,
    'Shell · error: documented',
  );
});

test('a payload that is not an object classifies as nothing', () => {
  for (const payload of [null, undefined, 'x', 42, []]) assert.equal(classifyToolFailure(payload), null);
});

test('the real turn_ended texts map to the codes the portal shows', () => {
  const cases = [
    [{ status: 'error', message: "You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more." }, 'rate_limit'],
    [{ status: 'error', message: '[resource_exhausted] Error' }, 'rate_limit'],
    [{ status: 'error', message: 'ERROR_RATE_LIMITED_CHANGEABLE' }, 'rate_limit'],
    // Cursor files this abort under status "error"; the text is what makes it an abort.
    [{ status: 'error', message: 'User aborted request' }, 'user_aborted'],
    [{ status: 'aborted', message: 'User aborted/interrupted manually.' }, 'user_aborted'],
    [{ status: 'error', message: 'Agent turn stopped after repeated resume attempts made no progress' }, 'agent_stalled'],
    [{ status: 'error', message: 'Something else broke' }, 'turn_error'],
  ];
  for (const [turn, code] of cases) {
    const out = classifyTurnError(turn);
    assert.equal(out.error, code, turn.message);
    assert.equal(out.errorDetails, turn.message);
  }
});

test('a successful turn is not an error', () => {
  assert.equal(classifyTurnError({ status: 'success' }), null);
  assert.equal(classifyTurnError({ status: 'completed' }), null);
  assert.equal(classifyTurnError({ status: 'Success', message: 'ignored' }), null);
});

test('a turn error with no text still says something', () => {
  assert.deepEqual(classifyTurnError({ status: 'error', message: null }), { error: 'turn_error', errorDetails: 'Turn ended with status "error"' });
  assert.deepEqual(classifyTurnError({ status: 'aborted' }), { error: 'user_aborted', errorDetails: 'Turn ended with status "aborted"' });
});

test('a status that is not a plain word is not echoed back', () => {
  assert.equal(classifyTurnError({ status: 'err"; drop', message: null }).errorDetails, 'Turn ended with status "unknown"');
});

test('a turn with neither status nor text is not evidence of anything', () => {
  assert.equal(classifyTurnError({ status: null, message: null }), null);
  assert.equal(classifyTurnError(null), null);
});

test('turn error text is redacted and capped too', () => {
  const out = classifyTurnError({ status: 'error', message: `token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB ${'x'.repeat(3000)}` });
  assert.ok(!out.errorDetails.includes('ghp_0123456789'));
  assert.ok(out.errorDetails.length <= ERROR_DETAILS_CAP);
});
