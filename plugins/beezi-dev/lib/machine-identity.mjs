import os from 'os';
import { AGENT } from './config.mjs';

// Client id of this machine's registered OAuth app; set wherever credentials are
// loaded, consumed by the HTTP helpers for the X-Beezi-Client header.
let clientId = null;

export function setMachineClientId(id) {
  clientId = id == null ? null : id;
}

// The current login's OAuth client id (dynamic registration mints a new one per login), used as
// the binding key for machine-global files that must not survive a workspace switch — the audit
// ledger and the tracking cache.
export function getMachineClientId() {
  return clientId;
}

// Identifying headers for the portal's linked-machines view (display/bookkeeping
// only — auth stays the bearer token). X-Beezi-Agent tells the server this is the Cursor
// client so it can attribute the machine and its analytics distinctly from Claude Code.
export function machineHeaders() {
  const headers = {
    'X-Beezi-Host': String(os.hostname()).slice(0, 255),
    'X-Beezi-Agent': AGENT,
  };
  if (clientId) headers['X-Beezi-Client'] = clientId;
  return headers;
}
