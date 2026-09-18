// The one door every other module uses. CONTRACTS.md §8 froze this surface; the hook runner, the
// MCP bridge, the auth lane, the queue delivery and the integrator's shared files all call these
// three functions and nothing deeper.
//
// The split behind it exists so the import graph stays a tree: telemetry-store has no dependencies
// of its own, consent reads the store, installation reads consent, the recorder reads installation,
// and the transport reads the recorder. Reaching past this facade into one of them is how a cycle
// or a second consent gate gets introduced.
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SOURCES,
  isKnownCode,
  isKnownSource,
  recordIssue as recordIssueInternal,
  setCurrentSource,
  suppressRecording,
  applyTelemetryRetention,
} from './telemetry-recorder.mjs';
import {
  CONSENT_MODES,
  CORRELATION_CONSENT_VERSION,
  setConsent,
  consentSummary,
  isTelemetryGranted,
  isCorrelationGranted,
  hasBeenAsked,
  hasNoticeBeenShown,
  markNoticeShown,
} from './telemetry-consent.mjs';
import {
  bindInstallation,
  currentInstallationId,
  needsBinding,
  rotateInstallation,
  readInstallationRecord,
} from './telemetry-installation.mjs';
import { maybeLaunchWorker, runWorker } from './telemetry-worker.mjs';
import { flushDiagnostics, postDiagnostics } from './telemetry-transport.mjs';

// Record one structured issue. Never throws, never blocks, and returns false rather than
// explaining itself — no call site may branch on whether a diagnostic landed.
//
// The `deps` seam is for the tests and for a caller that already knows its own correlation id or
// clock; a caller that passes nothing gets the real consent gate, the real queue and the real
// identity lookup.
export function recordIssue(code, fields = {}, deps = {}) {
  try {
    return recordIssueInternal(code, fields, deps);
  } catch {
    return false;
  }
}

// What the status surfaces (`beezi me`, the telemetry CLI) print. Booleans and counts only: this
// never opens a credential, a token store or a queued report, and it never returns the
// installation id itself — whether one is bound is a fact about consent, the value is not.
export function telemetryStatus() {
  const summary = consentSummary();
  const record = readInstallationRecord();
  return {
    enabled: summary.enabled,
    correlated: summary.correlated,
    decided: summary.decided,
    noticeShown: summary.noticeShown,
    pending: summary.pending,
    bound: summary.correlated && record !== null && record.boundAt != null,
  };
}

// The rotation callback the auth lane calls from `performLogout`, BEFORE it clears credentials.
// Events recorded after someone signs out must not correlate back to the account that just left
// the machine, and a missing identity file IS the rotated state.
export function onLogout() {
  try {
    return rotateInstallation();
  } catch {
    return false;
  }
}

// The one-time notice, for whichever surface actually shows it.
//
// Returns null once the user has decided or once a surface has stamped it — and deliberately does
// NOT stamp itself. Hook stdout may be dropped by Cursor without anyone noticing, so the caller
// prints first and calls `markNoticeShown()` second; a prompt nobody saw is not a prompt, and a
// displayed prompt, a timeout or silence is never consent.
export function pendingNotice() {
  try {
    if (hasBeenAsked() || hasNoticeBeenShown()) return null;
    return 'Beezi can send anonymous crash reports about this plugin — never your code, prompts, '
      + 'file paths or repository names. It is OFF unless you turn it on: run the beezi-telemetry '
      + 'skill, or `beezi telemetry on`. `beezi telemetry` on its own shows the current setting.';
  } catch {
    return null;
  }
}

export {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SOURCES,
  isKnownCode,
  isKnownSource,
  setCurrentSource,
  suppressRecording,
  applyTelemetryRetention,
  CONSENT_MODES,
  CORRELATION_CONSENT_VERSION,
  setConsent,
  isTelemetryGranted,
  isCorrelationGranted,
  hasBeenAsked,
  hasNoticeBeenShown,
  markNoticeShown,
  bindInstallation,
  currentInstallationId,
  needsBinding,
  maybeLaunchWorker,
  runWorker,
  flushDiagnostics,
  postDiagnostics,
};
