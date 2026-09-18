import fs from 'fs';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { namespaceSuffix } from './keyring-namespace.mjs';

// Which generation of a namespace's credential is current — as an append-only log of IMMUTABLE
// records, not one mutable file everybody rewrites.
//
// The rewrite design could not be made correct, and three rounds of guards on top of it did not
// change that. Publishing was `readControl()` … `writeJsonSecure()`: a read, then a write, with the
// whole staging transaction in between. Two writers could both read generation N, both decide they
// were publishing N+1, and both succeed — the second silently replacing the first. Adding a re-read
// immediately before the write narrowed the window without closing it, because a read followed by a
// write is not atomic however close together they are, and the rollback paths rewrote the record
// with no check at all.
//
// So the primitive changes. Each generation is its OWN file, created with the exclusive-create flag
// `wx`, which the operating system guarantees can succeed exactly once: the second creator gets
// EEXIST. That is a genuine compare-and-set, provided by the filesystem, and it is what publishing
// now is. Consequences that make the rest of the module simpler:
//
//   - There are no rewrites, so there are no unguarded rewrites. A record, once written, never
//     changes.
//   - There are no rollbacks. A commit that fails before publishing simply never created its file;
//     nothing has to be put back, and nothing a concurrent winner wrote can be clobbered.
//   - "Which generation is current" is the highest record present — one small directory listing, no
//     subprocess, and no dependence on a single file being readable.
//
// A tombstone (logout) is an ordinary record whose `backend` is null, so deleting is a publish like
// any other and gets the same atomicity.

export const CONTROL_VERSION = 1;

const PREFIX = 'credential-store';
const RECORD = /^credential-store(?:\.[A-Za-z0-9._-]+)?\.g([0-9]+)\.json$/;
const STAGING = /^credential-store(?:\.[A-Za-z0-9._-]+)?\.g([0-9]+)\.([A-Za-z0-9_-]+)\.staging\.json$/;

// The legacy single-file record this design replaces. Read once, migrated, then ignored.
export function legacyControlFile(service) {
  return path.join(beeziCursorHome(), `${PREFIX}${namespaceSuffix(service)}.json`);
}

export function recordFile(service, generation) {
  return path.join(beeziCursorHome(), `${PREFIX}${namespaceSuffix(service)}.g${generation}.json`);
}

// A writer's intent to stage a generation, so a crash leaves a cleanable orphan that the next
// commit can find without scanning any keyring.
//
// Keyed by generation AND ATTEMPT, for the same reason the secret slot is: a breadcrumb shared by
// generation is a breadcrumb two concurrent writers both read and both act on, and the first thing
// that cost was one writer deleting the other's staged secret while it was still live.
//
// A breadcrumb is a hint, never a lock. Arbitration belongs to `publishGeneration` alone.
export function stagingFile(service, generation, attempt) {
  return path.join(
    beeziCursorHome(),
    `${PREFIX}${namespaceSuffix(service)}.g${generation}.${attempt}.staging.json`,
  );
}

function parse(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return error != null && error.code === 'ENOENT' ? { missing: true } : { unreadable: true };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { corrupt: true };
  }
  if (record == null || typeof record !== 'object') return { corrupt: true };
  if (record.version !== CONTROL_VERSION) {
    return typeof record.version === 'number' && record.version > CONTROL_VERSION
      ? { tooNew: true, version: record.version }
      : { corrupt: true };
  }
  return { record };
}

// Every generation this namespace has a record for, highest first. A record whose name parses but
// whose content does not is skipped rather than fatal: the generation below it is still a true
// description of a credential that still exists, and refusing to read it would turn one bad write
// into an unlinked machine.
// One `readdir` of the environment's data root. That root holds a bounded set of plugin files plus
// this namespace's records, and pruning keeps the record count at one in steady state — so this is a
// small directory, and the call is still far cheaper than the keyring subprocess every credential
// read used to pay. It is deliberately not cached: a stale listing is how a process keeps serving a
// credential another process has already replaced.
function generationsPresent(service) {
  const suffix = namespaceSuffix(service);
  let names;
  try {
    names = fs.readdirSync(beeziCursorHome());
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const match = RECORD.exec(name);
    if (match == null) continue;
    // `credential-store.g1.json` and `credential-store.beezi-cursor-staging.g1.json` both match the
    // shape; only this namespace's spelling is ours.
    if (name !== `${PREFIX}${suffix}.g${match[1]}.json`) continue;
    found.push(Number(match[1]));
  }
  found.sort((a, b) => b - a);
  return found;
}

// The current record for this namespace, or `{ record: null, generation: 0 }` when there is none.
// Never throws.
//
// The HIGHEST record decides, whatever it says. A record that is present but unusable — truncated,
// or written by a client whose format this one does not know — is reported as such and never
// stepped over: below it there is either nothing (pruning removes superseded records) or an older
// credential that is no longer the current one, and serving either as "the store" would be a lie.
export function readCurrent(service) {
  const present = generationsPresent(service);
  if (present.length === 0) return { record: null, generation: 0, unreadable: false };

  const generation = present[0];
  const parsed = parse(recordFile(service, generation));
  if (parsed.record != null && parsed.record.service === service) {
    return { record: parsed.record, generation, unreadable: false };
  }
  if (parsed.tooNew === true) {
    return { record: null, generation: 0, unreadable: true, tooNew: true, version: parsed.version };
  }
  if (parsed.missing === true) {
    // It was listed and is gone: a concurrent prune. Whatever is there now is the answer.
    const again = generationsPresent(service);
    if (again.length > 0 && again[0] !== generation) return readCurrent(service);
    return { record: null, generation: 0, unreadable: false };
  }
  // Unparsable, or a record belonging to another namespace under our name.
  return { record: null, generation: 0, unreadable: true };
}

// Publish `record` AS generation N. Atomic: exactly one caller can succeed, and a loser is told so
// rather than overwriting the winner.
//
// -> 'published' | 'conflict' | 'failed'
export function publishGeneration(service, generation, record) {
  const file = recordFile(service, generation);
  const body = JSON.stringify({ ...record, version: CONTROL_VERSION, service, generation });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch { /* the write below reports what matters */ }
  try {
    // 'wx' is the compare-and-set. No temp file and no rename, so the Windows
    // rename-over-an-open-file failure this module used to retry around cannot arise either.
    fs.writeFileSync(file, body, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error != null && error.code === 'EEXIST') return 'conflict';
    return 'failed';
  }
  // writeFileSync only applies `mode` on some platforms; force it so a record can never be readable
  // more widely than the credential it describes. It holds no secret, but it names the store.
  try { fs.chmodSync(file, 0o600); } catch { /* no-op on Windows */ }
  return 'published';
}

// Record the intent. Never refuses — it is a hint for crash cleanup, not an arbiter.
export function noteStaged(service, generation, attempt, staged) {
  const file = stagingFile(service, generation, attempt);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch { /* the write below reports what matters */ }
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: CONTROL_VERSION, service, generation, attempt, ...staged, at: Date.now() }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    try { fs.chmodSync(file, 0o600); } catch { /* no-op on Windows */ }
  } catch { /* best effort */ }
}

export function releaseStaging(service, generation, attempt) {
  try { fs.unlinkSync(stagingFile(service, generation, attempt)); } catch { /* already gone */ }
}

// Every breadcrumb this namespace has, as { generation, attempt, record }.
function stagingPresent(service) {
  const suffix = namespaceSuffix(service);
  let names;
  try { names = fs.readdirSync(beeziCursorHome()); } catch { return []; }
  const found = [];
  for (const name of names) {
    const match = STAGING.exec(name);
    if (match == null) continue;
    if (name !== `${PREFIX}${suffix}.g${match[1]}.${match[2]}.staging.json`) continue;
    const parsed = parse(path.join(beeziCursorHome(), name));
    found.push({ generation: Number(match[1]), attempt: match[2], record: parsed.record == null ? null : parsed.record });
  }
  return found;
}

// Abandoned staged secrets, for generations at or below `settled`.
//
// TWO guards, because the cost of being wrong here is the live credential:
//
//   - the caller's own in-flight attempt is skipped (`exceptAttempt`);
//   - and so is any breadcrumb naming the slot the CURRENT record points at. A breadcrumb for the
//     published generation names the live secret, and it survives whenever a writer was killed
//     between publishing and releasing it — a window containing a keyring subprocess. Sweeping it
//     deleted the live secret while its record still stood: signed in, record intact, slot empty,
//     every later read MISSING. The guard was written (`currentSlot`) and then not called; this is
//     where it belongs.
//
// Callers should still prefer to sweep strictly below the current generation before staging, and
// leave at-or-equal generations to the sweep that runs AFTER a successful publish.
export function sweepStaging(service, settled, exceptAttempt, removeSlot) {
  const live = currentSlot(service);
  for (const entry of stagingPresent(service)) {
    if (entry.generation > settled) continue;
    if (entry.attempt === exceptAttempt) continue;
    const staged = entry.record;
    if (staged != null && typeof staged.slot === 'string' && staged.slot !== '' && staged.backend != null) {
      // Never the slot the committed record names, whatever generation the breadcrumb claims.
      if (live == null || staged.slot !== live.slot) {
        try { removeSlot(staged.backend, staged.slot); } catch { /* best effort */ }
      }
    }
    releaseStaging(service, entry.generation, entry.attempt);
  }
}

// The slot name the current record points at, for callers that need to address the live secret
// without knowing how a slot is spelled. Null when nothing is committed.
export function currentSlot(service) {
  const { record, generation } = readCurrent(service);
  if (record == null) return null;
  if (typeof record.slot === 'string' && record.slot !== '') return { slot: record.slot, backend: record.backend, generation };
  return { slot: `g${generation}`, backend: record.backend, generation };
}

// Retire records strictly below `generation`. Readers take the highest record, so removing lower
// ones can never change what is current — which is why this needs no lock and no check. Called after
// a successful publish purely to stop the directory growing.
export function pruneBelow(service, generation) {
  for (const present of generationsPresent(service)) {
    if (present >= generation) continue;
    try { fs.unlinkSync(recordFile(service, present)); } catch { /* already gone */ }
  }
}

// Adopt a store written by the single-mutable-file design. Idempotent and safe to race: the adoption
// itself is a `publishGeneration`, so two processes doing it at once resolve like any other pair of
// writers.
//
// -> 'adopted' | 'conflict' | 'none' | 'failed'
export function adoptLegacyControl(service) {
  const parsed = parse(legacyControlFile(service));
  if (parsed.record == null) return parsed.missing === true ? 'none' : 'failed';
  const record = parsed.record;
  if (record.service !== service) return 'none';
  const generation = typeof record.generation === 'number' ? record.generation : 0;
  // A generation-0 legacy record is a tombstone: the namespace was logged out. It is adopted as one
  // so a legacy scan does not resurrect the credential the user deleted.
  const outcome = publishGeneration(service, generation === 0 ? 1 : generation, {
    backend: generation === 0 ? null : record.backend,
    epoch: typeof record.epoch === 'number' ? record.epoch : 0,
    clientId: record.clientId == null ? null : record.clientId,
    updatedAt: record.updatedAt,
    adoptedFrom: 'legacy-control-record',
  });
  if (outcome !== 'published') return outcome === 'conflict' ? 'conflict' : 'failed';
  try { fs.unlinkSync(legacyControlFile(service)); } catch { /* best effort */ }
  return 'adopted';
}
