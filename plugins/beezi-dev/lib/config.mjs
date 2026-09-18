import { apiBase as resolveApiBase } from './env-identity.mjs';

// Resolution order lives in lib/env-identity.mjs, beside the data root and the keychain service that
// have to agree with it: BEEZI_API_URL -> localhost when the environment IS local -> the variant's
// baked base -> prod. A source checkout with no env.json talks to prod, never to a developer box —
// the implicit localhost default this replaces meant every clean install reported to nothing.
export function apiBase() {
  return resolveApiBase();
}

// Origin of the API host — the OAuth discovery documents are mounted at the
// root, outside the /api prefix.
export function apiOrigin() {
  return new URL(apiBase()).origin;
}

// Identifies this client to the Beezi API. Sent as the X-Beezi-Agent header on every
// request and used to select the cursor-scoped identity endpoints below, so the server
// can distinguish Cursor traffic from the Claude Code and Codex plugins.
export const AGENT = "cursor";

export const OAUTH_SCOPES = "email profile";

// The Beezi REST surface, in one place. Paths are relative to apiBase(). The ingest routes
// are FROZEN — they are a contract with the already-installed Claude Code and Codex plugins,
// and agent discrimination happens through the X-Beezi-Agent header, not the path. Only the
// identity routes are per-agent (parallel to /me/claude-code/* and /me/codex/*), so a linked
// machine and its analytics are attributed to the Cursor client.
export const ENDPOINTS = Object.freeze({
  sessionsReport: "/sessions/report",
  // Chunked backfill of past sessions (runs at the end of the beezi-login skill); duplicates are
  // absorbed by the server's upsert keys, and /complete seals the one-time pull. Shared routes —
  // the X-Beezi-Agent header picks the tool axis of the per-(tenant, user, tool) pull.
  sessionsBackfill: "/sessions/backfill",
  sessionsBackfillComplete: "/sessions/backfill/complete",
  // Repeatable history sync (the beezi-sync skill). /coverage reports how far each session already
  // reaches and the client resumes from exactly there, so a re-send is never wider than what is
  // missing. Shared routes; the X-Beezi-Agent header picks the tool axis.
  sessionsSync: "/sessions/sync",
  sessionsCoverage: "/sessions/coverage",
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  reposStatus: "/repos/status",
  whoami: "/me/cursor/whoami",
  machine: "/me/cursor/machine",
  // Self-diagnostics. The public route is deliberately unauthenticated — losing OAuth must not
  // also lose the evidence that OAuth broke — and the installation route is the authenticated
  // identity binding. Neither is agent-scoped: the wire vocabulary is shared with the other
  // plugins, and Cursor-specific fields are gated (see lib/telemetry-transport.mjs).
  pluginDiagnosticsPublic: "/cli-agent/plugin-diagnostics/public",
  pluginDiagnosticsInstallation: "/cli-agent/plugin-diagnostics/installation",
});

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
