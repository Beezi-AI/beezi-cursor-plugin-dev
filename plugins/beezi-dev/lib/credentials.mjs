import { lockOwner, withCredentialLock } from './credential-lock.mjs';
import {
  CONTROL_VERSION as _CONTROL_VERSION,
  adoptLegacyControl,
  legacyControlFile,
  noteStaged,
  pruneBelow,
  publishGeneration,
  readCurrent,
  recordFile,
  releaseStaging,
  sweepStaging,
} from './credential-control.mjs';
import {
  DEFAULT_SERVICE as _DEFAULT_SERVICE,
  customHome,
  defaultKeyringService,
} from './keyring-namespace.mjs';
import { keyringService as envKeyringService } from './env-identity.mjs';
import {
  BACKEND_TIMEOUT_MS,
  INTERACTIVE_RETRY_TIMEOUT_MS,
  ReadStatus,
  WriteStatus,
  backendById,
  backendChain,
  fileForSlot,
  isSafeKeyringName,
} from './credential-backends.mjs';

// The OS keyring entry this plugin owns. On Windows it is the target name shown under Control
// Panel → Credential Manager → Windows Credentials, so it has to say which agent it belongs to:
// the Claude Code plugin keeps `beezi-analytics` on the same machine, and two agents sharing one
// entry would fight over refreshed tokens and over logout.
export const DEFAULT_SERVICE = _DEFAULT_SERVICE;

// Kept for the callers and tests that named the constant before the service became resolvable.
export const SERVICE = DEFAULT_SERVICE;

// Every outcome this store can produce. The point of the list is that they are DISTINCT: a keyring
// that did not answer, a slot that is empty and a slot holding bytes we cannot parse used to
// collapse into one `null`, and "not linked" is the most destructive of the three readings — it is
// what made a slow Windows keyring read look like a logout.
export const CredentialStatus = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  TIMEOUT: 'timeout',
  UNREADABLE: 'unreadable',
  CORRUPT: 'corrupt',
  CONFLICT: 'conflict',
  LOCKED: 'locked',
  COMMITTED: 'committed',
  RECOVERY_NEEDED: 'recovery_needed',
  ERROR: 'error',
});

// The keyring namespace for this environment and home.
//
// The provider defaults to `lib/env-identity.mjs`'s `keyringService(env, customHome)` (CONTRACTS
// §1), which appends BOTH halves of the namespace: the environment suffix and the canonical-home
// digest. `deps.keyringService` stays injectable for tests. `defaultKeyringService()` remains the
// last-resort answer for a provider that returns nothing usable — it carries the home digest but
// not the environment suffix, which is the conservative direction: a store that cannot resolve its
// environment reads the production namespace it was already using rather than inventing a new one.
//
// Resolved at the point of USE, never at module scope: `keyringService` reaches `envName`, which
// throws ConfigError on an invalid BEEZI_CURSOR_ENV, and a throw during module evaluation turns a
// readable configuration error into an import failure — a hook that silently no-ops and an MCP
// server that never starts.
export function resolveServiceName(deps = {}) {
  const provider = typeof deps.keyringService === 'function' ? deps.keyringService : envKeyringService;
  // ONE bag, read once and used for every half of the answer. `customHome()` and
  // `defaultKeyringService()` both default to `process.env`, so calling them bare while the provider
  // got `deps.env` assembled the namespace out of two different environments: the injected bag's
  // environment suffix and the ambient process's home digest, naming an entry that belongs to
  // neither. Latent — nothing injects `deps.env` in production today — and latent is where it should
  // stay, so the bag is threaded rather than documented.
  const env = deps.env == null ? process.env : deps.env;
  const name = provider(env, customHome(env));
  return typeof name === 'string' && name !== '' ? name : defaultKeyringService(env);
}

// The slot a generation's secret lives in.
//
// It carries the WRITER'S OWN identity, not the generation alone. Naming it `g{N}` made the secret
// slot the one part of a commit that was still addressable by two writers at once: both would
// compute `g{N+1}`, the second's write would clobber the first's, and whichever lost the record
// publish would then delete the slot the winner's published record pointed at — leaving a committed
// record naming an empty slot, a user told they were signed in, and every later read MISSING.
//
// With an attempt id in the name, two concurrent writers cannot address the same slot at all, so a
// loser can only ever remove its own. That is the invariant: NO TWO CONCURRENT WRITERS ADDRESS THE
// SAME SLOT, AND NO WRITER DELETES A SLOT IT DID NOT CREATE — except the deliberate retirement of a
// superseded generation's slot, which is named by the record being superseded and is the whole point
// of retiring it.
const slotFor = (generation, attempt) => (attempt == null ? `g${generation}` : `g${generation}.${attempt}`);

// A record written before slots carried an attempt id names no slot; its secret is at the old name.
const slotOf = (record, generation) => (
  record != null && typeof record.slot === 'string' && record.slot !== ''
    ? record.slot
    : slotFor(generation)
);

// The backends store an opaque string. Since the Clerk OAuth migration that string is a JSON
// credentials object: { client_id, redirect_uri, token_endpoint, access_token, refresh_token,
// expires_at }. Legacy bare device tokens fail this and are not credentials.
function parseCredentials(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && typeof obj.access_token === 'string' ? obj : null;
  } catch {
    return null;
  }
}

function chainFor(deps, service) {
  return backendChain({
    run: deps.run,
    platform: deps.platform,
    timeoutMs: deps.timeoutMs == null ? BACKEND_TIMEOUT_MS : deps.timeoutMs,
    service,
  });
}

export const CONTROL_VERSION = _CONTROL_VERSION;

// Where this namespace's control records live. One file PER GENERATION, immutable, created with an
// exclusive-create flag — see lib/credential-control.mjs for why that replaced a single mutable
// record. `controlFile()` names the current one, and is kept because callers and tests ask "where is
// the store's bookkeeping" without caring how many files that is.
export function controlFile(deps = {}) {
  const service = resolveServiceName(deps);
  const { generation } = readCurrent(service);
  return generation > 0 ? recordFile(service, generation) : legacyControlFile(service);
}

// The current record, with the legacy single-file store adopted on first sight.
function readControl(service) {
  const current = readCurrent(service);
  if (current.record != null) return { status: CredentialStatus.OK, record: current.record, generation: current.generation };
  // RECOVERY_NEEDED, not UNREADABLE: M01.1 step 4 asks for that word, and it is the one that tells a
  // consumer this is repairable rather than merely broken. `scripts/login.mjs --recover-legacy`
  // adopts a credential an older client left; signing in again replaces the store outright.
  if (current.unreadable === true) {
    return { status: CredentialStatus.RECOVERY_NEEDED, record: null, generation: 0 };
  }

  const adopted = adoptLegacyControl(service);
  if (adopted === 'adopted' || adopted === 'conflict') {
    const after = readCurrent(service);
    if (after.record != null) return { status: CredentialStatus.OK, record: after.record, generation: after.generation };
    if (after.unreadable === true) {
      return { status: CredentialStatus.RECOVERY_NEEDED, record: null, generation: 0 };
    }
  }
  if (adopted === 'failed') return { status: CredentialStatus.RECOVERY_NEEDED, record: null, generation: 0 };
  return { status: CredentialStatus.MISSING, record: null, generation: 0 };
}

// The cheap, non-secret half of the store's state: which namespace and generation are current, and
// which identity epoch they belong to. Costs one small file read and no subprocess, which is what
// lets the token memo re-validate itself on every call instead of trusting a clock.
export function readControlSnapshot(deps = {}) {
  const service = resolveServiceName(deps);
  const { status, record, generation } = readControl(service);
  if (status !== CredentialStatus.OK) {
    return { service, generation: 0, epoch: 0, backend: null, clientId: null };
  }
  return {
    service,
    generation,
    epoch: typeof record.epoch === 'number' ? record.epoch : 0,
    backend: record.backend == null ? null : record.backend,
    clientId: record.clientId == null ? null : record.clientId,
  };
}

// ── reading

const readOutcome = (status, over = {}) => ({
  status,
  creds: null,
  generation: 0,
  epoch: 0,
  backend: null,
  service: null,
  ...over,
});

function readCommitted(chain, record, generation) {
  const backend = backendById(chain, record.backend);
  const base = {
    generation,
    epoch: typeof record.epoch === 'number' ? record.epoch : 0,
    backend: record.backend,
    service: record.service,
  };
  // The committed backend is not on this platform's chain: a store written by a keyring that has
  // since been uninstalled, or a home carried between machines. That is unreadable, not empty —
  // reporting "not linked" would invite a relink that cannot recover the seat either.
  if (backend == null) return readOutcome(CredentialStatus.UNREADABLE, base);

  const r = backend.read(slotOf(record, generation));
  if (r.status === ReadStatus.TIMEOUT) return readOutcome(CredentialStatus.TIMEOUT, base);
  if (r.status === ReadStatus.UNREADABLE) return readOutcome(CredentialStatus.UNREADABLE, base);
  if (r.status === ReadStatus.MISSING) return readOutcome(CredentialStatus.MISSING, base);
  const creds = parseCredentials(r.value);
  if (creds == null) return readOutcome(CredentialStatus.CORRUPT, base);
  return readOutcome(CredentialStatus.OK, { ...base, creds });
}

// Which backends may still hold a pre-generation value, and in which slot.
//
// The legacy FILE slot lives inside this home, so it is always ours to migrate. The legacy KEYRING
// entry does not: it is keyed by the service name alone, which every home on the machine shared
// before this change. Only the default home running under the production service may adopt it.
function legacySlots(chain, service) {
  // Only a DEFAULT home running the production service may adopt the pre-generation keyring entry a
  // shipped version left behind. A test or dev store that scanned it would be reading — and, on
  // logout, deleting — the developer's real credentials.
  const productionLegacy = service === DEFAULT_SERVICE && customHome() === null;
  const slots = [];
  for (const backend of chain) {
    const fileBacked = backend.id === 'file' || backend.id === 'dpapi-file';
    if (fileBacked || productionLegacy) slots.push(backend);
  }
  return slots;
}

// Look for a pre-generation value. Returns { found, creds, backend, raw } or a recovery verdict.
function scanLegacy(chain, service) {
  for (const backend of legacySlots(chain, service)) {
    if (!backend.available()) continue;
    const r = backend.read('');
    if (r.status === ReadStatus.MISSING) continue;
    if (r.status === ReadStatus.TIMEOUT) return { status: CredentialStatus.TIMEOUT };
    if (r.status === ReadStatus.UNREADABLE) return { status: CredentialStatus.RECOVERY_NEEDED };
    const creds = parseCredentials(r.value);
    // Something is there and it is not a credential: a bare device token from before the OAuth
    // migration, or a half-written file. Adopting some OTHER backend's value while this one holds
    // bytes we cannot read is how a stale token silently becomes the current one — so stop here and
    // say the store needs recovery, leaving the bytes untouched.
    if (creds == null) return { status: CredentialStatus.RECOVERY_NEEDED };
    return { status: CredentialStatus.OK, creds, raw: r.value, backend };
  }
  return { status: CredentialStatus.MISSING };
}

// The full read: control record first, and only a store that has never been through this version
// falls back to the legacy scan.
export async function readCredentialRecord(deps = {}) {
  const service = resolveServiceName(deps);
  const chain = chainFor(deps, service);
  const control = readControl(service);

  if (control.status === CredentialStatus.OK) {
    // A record naming no backend is a TOMBSTONE: this namespace was logged out. It is empty on
    // purpose, and a legacy scan here would resurrect the credential the user just deleted.
    if (control.record.backend == null) {
      return readOutcome(CredentialStatus.MISSING, {
        epoch: typeof control.record.epoch === 'number' ? control.record.epoch : 0,
        service,
      });
    }
    {
      const committed = readCommitted(chain, control.record, control.generation);
      // The interactive retry. A hook is on a deadline and takes the answer it gets; a person
      // waiting at a prompt would rather wait three more seconds than be told their machine is not
      // linked because a cold keychain helper missed a 5s budget. ONE retry, explicitly bounded,
      // and only when the caller said it is interactive and named no budget of its own.
      if (committed.status === CredentialStatus.TIMEOUT && deps.interactive === true && deps.timeoutMs == null) {
        const patient = chainFor({ ...deps, timeoutMs: INTERACTIVE_RETRY_TIMEOUT_MS }, service);
        return readCommitted(patient, control.record, control.generation);
      }
      return committed;
    }
  }
  // Anything other than OK or "there is nothing here" must NOT reach the legacy scan below: a store
  // that exists and cannot be used is not an empty store, and adopting some other backend's value on
  // the strength of it is exactly what M01.1 step 4 forbids.
  if (control.status !== CredentialStatus.MISSING) {
    return readOutcome(control.status, { service });
  }

  const legacy = scanLegacy(chain, service);
  if (legacy.status !== CredentialStatus.OK) return readOutcome(legacy.status, { service });

  // Upgrade it ONCE, under the lock.
  const migrated = await migrateLegacy(legacy, chain, service, deps);
  if (migrated.outcome != null) return migrated.outcome;
  if (migrated.locked === true) {
    // Another process is migrating this very store right now. Serving the legacy value at
    // generation 0 would hand the caller a generation that is stale the instant that process
    // publishes — and a caller that then FENCED on it (logout does) would report a conflict on a
    // machine that is perfectly linked. LOCKED is retryable and true.
    return readOutcome(CredentialStatus.LOCKED, { service });
  }
  // The migration itself could not commit — no backend would hold the value. Nothing else is
  // mutating the store, so the legacy value really is the current one: report it rather than
  // telling a linked machine it is not linked. Generation 0 is accurate; nothing is committed.
  return readOutcome(CredentialStatus.OK, { creds: legacy.creds, generation: 0, service });
}

// -> { outcome } | { locked: true } | { failed: true }
//
// The reason travels in the RETURN VALUE. It used to be a module-level flag, which two concurrent
// reads in one process (the bridge has them) would clobber for each other — one read's "the lock was
// busy" becoming another's.
async function migrateLegacy(legacy, chain, service, deps) {
  const result = await withCredentialLock(async (handle) => {
    // Re-read under the lock: another process may have migrated while we were queuing.
    const control = readControl(service);
    if (control.status === CredentialStatus.OK) {
      if (control.record.backend == null) return readOutcome(CredentialStatus.MISSING, { service });
      return readCommitted(chain, control.record, control.generation);
    }
    const again = scanLegacy(chain, service);
    if (again.status !== CredentialStatus.OK) return null;
    const committed = await commitUnderLock(again.raw, again.creds, chain, service, null, handle, {
      previous: null,
      retireLegacy: legacySlots(chain, service),
    });
    if (committed.status !== CredentialStatus.COMMITTED) return null;
    return readOutcome(CredentialStatus.OK, {
      creds: again.creds,
      generation: committed.generation,
      epoch: committed.epoch,
      backend: committed.backend,
      service,
    });
  }, lockOptions(deps));
  if (result != null && result.ok === false) return { locked: true };
  return result == null ? { failed: true } : { outcome: result };
}

function lockOptions(deps, options) {
  return {
    waitMs: deps.lockWaitMs,
    kill: deps.kill,
    sleep: deps.sleep,
    now: deps.lockNow,
    // The caller's existing lease, when this call is nested inside one. Re-entrancy is granted by
    // HOLDING the handle and never by "some call in this process is inside a critical section" —
    // that description also fits a completely unrelated caller that arrived while one was running.
    lock: options != null && options.lock != null ? options.lock : deps.lock,
  };
}

// ── committing

// Distinguishes two attempts by the SAME process (the CONFLICT rebase below makes a second one), so
// a retry never reuses the slot name its first attempt may have left behind.
let attempts = 0;
function attemptCounter() {
  attempts += 1;
  return attempts;
}

async function commitUnderLock(raw, creds, chain, service, expectGeneration, handle, options) {
  const control = readControl(service);
  const scoped = control.status === CredentialStatus.OK ? control.record : null;
  const current = control.status === CredentialStatus.OK ? control.generation : 0;
  if (expectGeneration != null && expectGeneration !== current) {
    return { status: CredentialStatus.CONFLICT, generation: current };
  }

  const nextGeneration = current + 1;
  // Unique to this attempt. It comes from THIS PROCESS's own lock nonce, never from the handle: a
  // handle can be constructed by a caller or describe another process's lease, and two writers that
  // derived their slot name from the same handle would be right back to sharing a slot.
  const attempt = `${lockOwner().nonce}${attemptCounter()}`;
  const slot = slotFor(nextGeneration, attempt);
  const previousEpoch = scoped == null || typeof scoped.epoch !== 'number' ? 0 : scoped.epoch;
  const previousClient = scoped == null ? null : scoped.clientId;
  const clientId = creds != null && typeof creds.client_id === 'string' ? creds.client_id : null;
  // A refresh rewrites the same client's token and must NOT advance the epoch, or every sender in
  // the plugin would defer its payload on the §2 fence each time a token aged out. Dynamic client
  // registration mints a new client_id per login, so a changed one is a new identity.
  const epoch = scoped != null && previousClient != null && previousClient === clientId
    ? previousEpoch
    : previousEpoch + 1;

  // Sweep abandoned staged secrets for generations that are already SETTLED. A published
  // generation is over, so any slot for it other than the one its record names belongs to a writer
  // that lost — unreferenced, and a credential outliving its transaction if left. Our own attempt is
  // excluded, and generations above `current` are left strictly alone: a slot there may belong to a
  // live concurrent writer, and deleting it is precisely what corrupted the store before.
  const removeSlot = (backendId, name) => {
    const backend = backendById(chain, backendId);
    if (backend != null) backend.remove(name);
  };
  // Strictly BELOW the current generation: those are definitively superseded, so no slot of theirs
  // can be the live one. Breadcrumbs for `current` itself are left to the post-publish sweep below,
  // which runs when this transaction has already replaced that generation.
  sweepStaging(service, current - 1, attempt, removeSlot);

  // The lock is the primary exclusion and this is where it is checked — before this transaction
  // writes anything. A caller whose lease was reclaimed underneath it stops here without having
  // touched the committed generation. (The sweep above may have removed superseded slots, which are
  // by definition not the committed one.)
  if (handle != null && typeof handle.verify === 'function' && !handle.verify()) {
    return { status: CredentialStatus.CONFLICT, generation: current };
  }

  let chosen = null;
  for (const backend of chain) {
    if (!backend.available()) continue;
    const w = backend.write(slot, raw);
    if (w.status !== WriteStatus.OK) continue;
    // Reread and validate: a write the backend called a success but cannot serve back is not a
    // value we may publish over a perfectly good previous generation.
    const verify = backend.read(slot);
    if (verify.status !== ReadStatus.OK || verify.value !== raw) {
      try { backend.remove(slot); } catch { /* best effort */ }
      continue;
    }
    chosen = { backend, where: w.where };
    // Now the breadcrumb can say where the secret actually went, which is what makes the cleanup
    // above reachable at all: until this point nobody knew which backend would take it.
    noteStaged(service, nextGeneration, attempt, { backend: backend.id, slot, state: 'staged' });
    break;
  }

  if (chosen == null) {
    // Nothing could hold the new value. No record was written and no committed slot was touched, so
    // the previous generation is still current and still readable.
    releaseStaging(service, nextGeneration, attempt);
    return { status: CredentialStatus.ERROR, generation: current };
  }

  // Publication. This single call IS the compare-and-set: the filesystem lets exactly one creator
  // of this generation's record win, so a writer that lost the race is told so instead of silently
  // replacing the winner. There is deliberately no read-then-write and no re-check before it —
  // a check followed by a write is not atomic however close together the two sit, which is what
  // three previous rounds of guards kept failing to fix.
  // Second ownership check, immediately before publishing: between the staged write and here sit
  // keyring subprocesses costing hundreds of milliseconds, which is ample time to lose a lease.
  if (handle != null && typeof handle.verify === 'function' && !handle.verify()) {
    try { chosen.backend.remove(slot); } catch { /* best effort */ }
    releaseStaging(service, nextGeneration, attempt);
    return { status: CredentialStatus.CONFLICT, generation: current };
  }

  const published = publishGeneration(service, nextGeneration, {
    backend: chosen.backend.id,
    // The record names the EXACT slot this writer validated, so a reader follows the winner's
    // secret and never a name another writer could also have chosen.
    slot,
    epoch,
    clientId,
    updatedAt: new Date().toISOString(),
  });

  if (published !== 'published') {
    // Lost the race, or could not write at all. Either way this transaction's secret is the only
    // thing to clean up; whoever won owns the generation and its own slot.
    try { chosen.backend.remove(slot); } catch { /* best effort */ }
    releaseStaging(service, nextGeneration, attempt);
    const after = readControl(service);
    const latest = after.status === CredentialStatus.OK ? after.generation : current;
    return {
      status: published === 'conflict' ? CredentialStatus.CONFLICT : CredentialStatus.ERROR,
      generation: latest,
    };
  }

  // Published — now the old generation is safe to retire. Only ever these exact slots.
  if (scoped != null && current > 0 && scoped.backend != null) {
    const previous = backendById(chain, scoped.backend);
    // By the name the superseded record itself carries — never a name recomputed from the
    // generation, which is how a writer could otherwise delete a slot that was never its to delete.
    if (previous != null) { try { previous.remove(slotOf(scoped, current)); } catch { /* best effort */ } }
  }
  const retire = options == null || options.retireLegacy == null ? [] : options.retireLegacy;
  for (const backend of retire) {
    try { backend.remove(''); } catch { /* best effort */ }
  }
  releaseStaging(service, nextGeneration, attempt);
  // Now that this generation is published, any other writer's slot for it is a loser's and may go.
  sweepStaging(service, nextGeneration, attempt, removeSlot);
  pruneBelow(service, nextGeneration);

  return {
    status: CredentialStatus.COMMITTED,
    generation: nextGeneration,
    epoch,
    backend: chosen.backend.id,
    where: chosen.where,
  };
}

// Replace the stored credential, transactionally. `options.expectGeneration` fences a caller that
// read a generation and must not overwrite a newer one.
export async function commitCredentials(creds, deps = {}, options = {}) {
  const service = resolveServiceName(deps);
  const chain = chainFor(deps, service);
  const raw = JSON.stringify(creds);
  const attempt = () => withCredentialLock(
    async (handle) => {
      try {
        return await commitUnderLock(raw, creds, chain, service, options.expectGeneration, handle, {
          retireLegacy: legacySlots(chain, service),
        });
      } catch {
        // Nothing may escape the critical section. A throw here would skip the release, and the
        // process would exit leaving a lock directory for the next one to reclaim — which is how one
        // transient filesystem error turns into a reclaim race between everybody else.
        return { status: CredentialStatus.ERROR, generation: null };
      }
    },
    lockOptions(deps, options),
  );

  let result = await attempt();
  // What a CONFLICT means is the CALLER'S to declare, because the answer differs per caller and
  // guessing it from `expectGeneration == null` quietly gave every unfenced caller a retry:
  //
  //   'abandon' (the default) — the value being committed was minted against state that has since
  //       moved, so publishing it would replace a newer generation with an older decision. A refresh
  //       computed its token from the credential it read; a logout observed a specific generation.
  //       Both must stop, and both are reported as CONFLICT.
  //   'rebase' — the value does not depend on the state it is replacing. A fresh OAuth grant is the
  //       user's just-expressed intent and is valid whatever was there a moment ago, so ONE more
  //       attempt is made. That attempt re-reads the record and recomputes the generation and the
  //       epoch from what it finds; it never republishes the arithmetic of the first try.
  //
  // `expectGeneration` still fences independently: a caller that named a generation is refused
  // before anything is written, whatever it asked for here.
  const onConflict = options.onConflict == null ? 'abandon' : options.onConflict;
  if (result != null && result.status === CredentialStatus.CONFLICT
    && onConflict === 'rebase' && options.expectGeneration == null) {
    result = await attempt();
  }
  if (result != null && result.ok === false) return { status: CredentialStatus.LOCKED, generation: null };
  return result;
}

// ── deleting

// Erase this namespace's credential and prove it. A logout that reports success while the keyring
// still serves the token is AUTH-01 itself, so the committed slot is re-read afterwards and a value
// that survives is an error, not a warning.
export async function deleteCredentialRecord(deps = {}, options = {}) {
  const service = resolveServiceName(deps);
  const chain = chainFor(deps, service);
  const result = await withCredentialLock(async (handle) => {
    const control = readControl(service);
    const scoped = control.status === CredentialStatus.OK ? control.record : null;
    const generation = control.status === CredentialStatus.OK ? control.generation : 0;
    const epoch = scoped == null || typeof scoped.epoch !== 'number' ? 0 : scoped.epoch;

    // A caller that observed a generation deletes THAT one or nothing. Without the fence, a logout
    // that read the store before a sign-in landed would delete the credential the sign-in had just
    // committed — the user signs in, and a logout already in flight signs them straight back out.
    if (options.expectGeneration != null && options.expectGeneration !== generation) {
      return { status: CredentialStatus.CONFLICT, deleted: false, verified: false, generation };
    }
    if (scoped == null || scoped.backend == null) {
      // Already empty. Publishing another tombstone would advance the epoch for nothing.
      return { status: CredentialStatus.OK, deleted: false, verified: true, generation };
    }

    // The tombstone is a PUBLISH of the next generation, so it is the same compare-and-set every
    // other mutation uses: a login that landed while this logout was on the network loses the race
    // here — or wins it, in which case the tombstone is refused and its credential survives.

    const backend = backendById(chain, scoped.backend);
    let deleted = false;
    let verified = false;
    if (backend != null) {
      // The slot the CURRENT record names, not one recomputed from the generation.
      const live = slotOf(scoped, generation);
      try { backend.remove(live); } catch { /* checked below */ }
      const after = backend.read(live);
      // MISSING is the proof. TIMEOUT and UNREADABLE are not: they say the store did not answer,
      // and "we could not check" must never be printed as "revoked".
      verified = after.status === ReadStatus.MISSING;
      deleted = verified;
    }

    if (!verified) {
      // The secret is still readable. Publishing a tombstone here would make the very next read —
      // and the next logout — say "this machine is not linked" while the token sits in the
      // keychain, which is AUTH-01 wearing a different hat. Leave the current record standing so a
      // retry finds the same credential and tries again.
      return { status: CredentialStatus.ERROR, deleted, verified: false, generation };
    }

    // Legacy slots go too — a pre-generation copy left behind is a credential that outlives logout.
    for (const legacy of legacySlots(chain, service)) {
      try { legacy.remove(''); } catch { /* best effort */ }
    }

    // A tombstone, not an absent record: the epoch has to keep advancing across a logout/login
    // pair, and nothing at all would restart it and let a later epoch string repeat an earlier one.
    const tombstoned = publishGeneration(service, generation + 1, {
      backend: null,
      epoch: epoch + 1,
      clientId: null,
      updatedAt: new Date().toISOString(),
    });
    if (tombstoned !== 'published') {
      // Lost to a concurrent login, or could not write. The secret IS gone — that much is verified
      // — but this namespace's state is now whatever the winner published, and saying "logged out"
      // about their credential would be wrong.
      return {
        status: tombstoned === 'conflict' ? CredentialStatus.CONFLICT : CredentialStatus.ERROR,
        deleted,
        verified: false,
        generation,
      };
    }
    pruneBelow(service, generation + 1);

    return { status: CredentialStatus.OK, deleted, verified: true, generation };
  }, lockOptions(deps, options));
  if (result != null && result.ok === false) {
    return { status: CredentialStatus.LOCKED, deleted: false, verified: false, generation: null };
  }
  return result;
}

// ── recovering a credential written by an older client

// The rollback hole this closes: an older build reads `credentials.json`, which migration retired,
// so it reports "not linked"; the user signs in again and that build writes the LEGACY slot; the
// machine is then upgraded again, finds a control record, reads the generation slot it names — and
// serves the token from before the downgrade. Nothing is corrupt and nothing errors; the machine
// simply presents a credential the user replaced.
//
// It is not detectable on the read path at any acceptable cost: the committed slot answers
// perfectly well, and confirming it is the NEWEST value would mean a second keyring subprocess on
// every hook. So this is an explicit repair (`scripts/login.mjs --recover-legacy`) rather than a
// silent one, and the rollback contract is documented alongside it.
//
// -> { status, generation?, where?, reason? }
export async function recoverLegacyCredential(deps = {}) {
  const service = resolveServiceName(deps);
  const chain = chainFor(deps, service);
  const slots = legacySlots(chain, service);

  const found = scanLegacy(chain, service);
  if (found.status !== CredentialStatus.OK) {
    // MISSING is the healthy case: no older client has written here since the migration.
    return { status: found.status };
  }

  const result = await withCredentialLock(async (handle) => {
    try {
      const again = scanLegacy(chain, service);
      if (again.status !== CredentialStatus.OK) return { status: again.status };
      // Committed as a NEW generation, so it wins over whatever the control record names and the old
      // generation is retired in the same transaction. The legacy slot is retired with it.
      return await commitUnderLock(again.raw, again.creds, chain, service, null, handle, { retireLegacy: slots });
    } catch {
      // Nothing may escape the critical section — the same rule commitCredentials keeps. A throw
      // here would skip the release and leave a lock directory for the next process to reclaim.
      return { status: CredentialStatus.ERROR };
    }
  }, lockOptions(deps));

  if (result != null && result.ok === false) return { status: CredentialStatus.LOCKED };
  if (result.status !== CredentialStatus.COMMITTED) return { status: result.status };
  return { status: CredentialStatus.COMMITTED, generation: result.generation, where: result.where };
}

// ── compatibility adapters
//
// The three functions every existing caller imports. They keep their old shapes — a credentials
// object or null, a "where it landed" sentence, and a best-effort delete — so the typed API above
// could be introduced without a flag day. New callers that need to tell a timeout from an empty
// store use readCredentialRecord/commitCredentials/deleteCredentialRecord directly.

export async function getCredentials(deps = {}) {
  const record = await readCredentialRecord(deps);
  return record.status === CredentialStatus.OK ? record.creds : null;
}

// Returns a human-readable description of where the credentials were actually stored, so the caller
// can report accurately (keychain vs a local file) instead of always claiming the keychain.
export async function setCredentials(creds, deps = {}) {
  // The compatibility adapter is the sign-in path — `performLogin` stores through it — so it carries
  // the fresh-grant conflict policy. Callers that must abandon on a conflict (refresh, logout) use
  // `commitCredentials`/`deleteCredentialRecord` directly and get the safe default.
  const result = await commitCredentials(creds, deps, { onConflict: 'rebase' });
  return result != null && result.where ? result.where : 'a restricted local file';
}

export async function deleteCredentials(deps = {}) {
  await deleteCredentialRecord(deps);
}

// Re-exported so callers do not have to know the file layout to write a fixture or a test.
export { fileForSlot, isSafeKeyringName };
