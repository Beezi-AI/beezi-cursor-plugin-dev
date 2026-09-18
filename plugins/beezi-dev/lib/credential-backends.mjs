import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { credentialsFile } from './paths-cursor.mjs';
import { writeJsonSecure } from './fs-store.mjs';

// The platform credential stores, behind one result-typed interface.
//
// Split out of lib/credentials.mjs because the store became transactional: a value is written into
// a GENERATION-SPECIFIC slot and only becomes current when the control record names it, so every
// backend now has to address more than one slot, and the caller has to be able to tell "this slot
// holds nothing" from "the keychain did not answer in time". Collapsing those two — which a bare
// `string | null` return forces — is what let a slow Windows keyring read look exactly like a
// logout, and made a hook report the machine unlinked while its credentials sat safely in the OS
// store the whole time.

export const BackendId = Object.freeze({
  KEYCHAIN: 'keychain',
  LIBSECRET: 'libsecret',
  CREDMAN: 'credman',
  DPAPI_FILE: 'dpapi-file',
  FILE: 'file',
});

export const ReadStatus = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  TIMEOUT: 'timeout',
  UNREADABLE: 'unreadable',
});

export const WriteStatus = Object.freeze({ OK: 'ok', ERROR: 'error', TIMEOUT: 'timeout' });

// Default subprocess budget. A hook caller shrinks it to what its own deadline has left; an
// interactive caller (login, logout, the status command) may spend the longer retry budget once.
export const BACKEND_TIMEOUT_MS = 5000;
export const INTERACTIVE_RETRY_TIMEOUT_MS = 15_000;

const ACCOUNT_BASE = 'token';

// Everything below is interpolated into a PowerShell script and into argv. The default service name
// is a constant and the generation suffix is a number, but `keyringService` is INJECTABLE (the
// release lane supplies the real one), so the value is validated rather than trusted: a service
// name carrying a quote would break out of the single-quoted PowerShell literal it lands in.
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeKeyringName(value) {
  return typeof value === 'string' && SAFE_NAME.test(value);
}

// The keyring account for a slot. `''` is the LEGACY, pre-generation entry that shipped versions
// wrote; everything this version commits lives under a generation-specific name.
export function accountForSlot(slot) {
  return slot === '' || slot == null ? ACCOUNT_BASE : `${ACCOUNT_BASE}.${slot}`;
}

// The file-store path for a slot, derived from the environment's own credentials file so a custom
// BEEZI_CURSOR_HOME keeps every generation inside that home.
export function fileForSlot(slot) {
  const legacy = credentialsFile();
  if (slot === '' || slot == null) return legacy;
  const dir = path.dirname(legacy);
  const base = path.basename(legacy, '.json');
  return path.join(dir, `${base}.${slot}.json`);
}

// Absolute path to PowerShell — never a bare name. On Windows a bare `powershell.exe` is resolved
// against the child's current directory first, so an attacker file dropped in a repo the user opens
// could be executed (and would receive the plaintext token on stdin). Pinning the system path
// closes that hijack.
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout, timedOut } so callers can classify rather than guess.
function defaultRun(file, args, input, timeoutMs) {
  try {
    const stdout = execFileSync(file, args, {
      input: input == null ? undefined : input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      // Bound the spawn: a locked keychain / hung helper must not block the hook.
      timeout: timeoutMs == null ? BACKEND_TIMEOUT_MS : timeoutMs,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: stdout == null ? '' : stdout, timedOut: false };
  } catch (error) {
    // execFileSync reports a budget kill through `killed`/`signal`, not through the exit code —
    // the distinction between "the keychain said no" and "the keychain never answered".
    const timedOut = error != null && (error.killed === true || error.signal === 'SIGKILL');
    return { ok: false, stdout: '', timedOut };
  }
}

// A subprocess result becomes a read result. A keyring CLI exits non-zero both when the entry is
// absent and when the store is locked, and neither `security` nor `secret-tool` distinguishes the
// two in a way that survives a locale change — so a plain failure is reported as MISSING (today's
// behaviour) and only a budget overrun is promoted to TIMEOUT.
function readResultFrom(r) {
  if (r.timedOut) return { status: ReadStatus.TIMEOUT, value: null };
  const value = r.ok && r.stdout != null ? r.stdout.trim() : '';
  return value ? { status: ReadStatus.OK, value } : { status: ReadStatus.MISSING, value: null };
}

const writeResult = (r, label) => (
  r.timedOut ? { status: WriteStatus.TIMEOUT, where: null }
    : r.ok ? { status: WriteStatus.OK, where: label }
      : { status: WriteStatus.ERROR, where: null }
);

// ── the file store: always available, and where the Windows DPAPI ciphertext is kept ──

function readFileSlot(slot) {
  let raw;
  try {
    raw = fs.readFileSync(fileForSlot(slot), 'utf-8');
  } catch (error) {
    // ENOENT is an empty slot. Anything else — EACCES on a file someone chmod'ed, EIO on a failing
    // disk — is a store we could not read, and reporting that as "not linked" is what turns a
    // recoverable problem into a relink the user did not need.
    if (error != null && error.code === 'ENOENT') return { status: ReadStatus.MISSING, value: null };
    return { status: ReadStatus.UNREADABLE, value: null };
  }
  try {
    const obj = JSON.parse(raw);
    if (obj == null || typeof obj !== 'object') return { status: ReadStatus.UNREADABLE, value: null };
    return { obj, status: ReadStatus.OK, value: null };
  } catch {
    return { status: ReadStatus.UNREADABLE, value: null };
  }
}

function fileDelete(slot) {
  try {
    fs.unlinkSync(fileForSlot(slot));
    return { status: WriteStatus.OK };
  } catch (error) {
    if (error != null && error.code === 'ENOENT') return { status: WriteStatus.OK };
    return { status: WriteStatus.ERROR };
  }
}

function fileBackend() {
  return {
    id: BackendId.FILE,
    label: 'a restricted local file',
    available: () => true,
    read(slot) {
      const r = readFileSlot(slot);
      if (r.obj === undefined) return { status: r.status, value: null };
      return typeof r.obj.token === 'string' && r.obj.token
        ? { status: ReadStatus.OK, value: r.obj.token }
        : { status: ReadStatus.MISSING, value: null };
    },
    write(slot, value) {
      try {
        writeJsonSecure(fileForSlot(slot), { token: value });
        return { status: WriteStatus.OK, where: 'a restricted local file' };
      } catch {
        return { status: WriteStatus.ERROR, where: null };
      }
    },
    remove: fileDelete,
  };
}

// ── macOS / Linux keyrings ──

function macBackend(run, service, timeoutMs) {
  return {
    id: BackendId.KEYCHAIN,
    label: 'the macOS keychain',
    available: () => true, // `security` ships with macOS
    read(slot) {
      return readResultFrom(run(
        'security',
        ['find-generic-password', '-s', service, '-a', accountForSlot(slot), '-w'],
        undefined,
        timeoutMs,
      ));
    },
    write(slot, value) {
      return writeResult(
        run('security', ['add-generic-password', '-U', '-s', service, '-a', accountForSlot(slot), '-w', value], undefined, timeoutMs),
        'the macOS keychain',
      );
    },
    remove(slot) {
      const r = run('security', ['delete-generic-password', '-s', service, '-a', accountForSlot(slot)], undefined, timeoutMs);
      // "no such entry" and "deleted" are the same outcome for a caller that wants the slot empty;
      // only a budget overrun leaves the slot's state genuinely unknown.
      return { status: r.timedOut ? WriteStatus.TIMEOUT : WriteStatus.OK };
    },
  };
}

function secretToolBackend(run, service, timeoutMs) {
  const attrs = (slot) => ['service', service, 'account', accountForSlot(slot)];
  return {
    id: BackendId.LIBSECRET,
    label: 'the OS secret service (libsecret)',
    available: () => run('secret-tool', ['--version'], undefined, timeoutMs).ok, // libsecret often absent
    read(slot) {
      return readResultFrom(run('secret-tool', ['lookup', ...attrs(slot)], undefined, timeoutMs));
    },
    write(slot, value) {
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return writeResult(
        run('secret-tool', ['store', `--label=${service}`, ...attrs(slot)], value, timeoutMs),
        'the OS secret service (libsecret)',
      );
    },
    remove(slot) {
      const r = run('secret-tool', ['clear', ...attrs(slot)], undefined, timeoutMs);
      return { status: r.timedOut ? WriteStatus.TIMEOUT : WriteStatus.OK };
    },
  };
}

// ── Windows ──
//
// The primary store is the Credential Manager, reached via a P/Invoke to advapi32 (CredWrite/
// CredRead/CredDelete) — the token then appears under Control Panel → Credential Manager → Windows
// Credentials, keyed by the service name. The `cmdkey` CLI can *store* but not read a secret back,
// so we call the Win32 API directly through PowerShell. Should that ever fail (locked-down box,
// PowerShell missing) we fall back to DPAPI (user-bound OS crypto) with the ciphertext kept in the
// 0600 file, and finally to a plaintext 0600 file.
const DPAPI_ENC = "$in=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.Security;"
  + "$b=[Text.Encoding]::UTF8.GetBytes($in);"
  + "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
  + '[Convert]::ToBase64String($e)';
const DPAPI_DEC = "$in=[Console]::In.ReadToEnd().Trim();Add-Type -AssemblyName System.Security;"
  + "$b=[Convert]::FromBase64String($in);"
  + "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
  + '[Text.Encoding]::UTF8.GetString($d)';

function powershell(run, script, input, timeoutMs) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input, timeoutMs);
}

// The CREDENTIAL struct is shared by the read and write scripts. CharSet=Unicode marshals
// TargetName/UserName as wide strings; the secret blob is written/read as UTF-16 so it round-trips
// any character (verified against '&', '=', '.').
const CRED_STRUCT = `
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type;
  public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}`;

// Reads the secret from stdin (never an argv element, so it can't leak via the process list),
// writes a GENERIC credential with LOCAL_MACHINE persistence, prints 'OK' on success.
const credWrite = (target, account) => `$in=[Console]::In.ReadToEnd()
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredW {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite([In] ref CREDENTIAL c, uint flags);${CRED_STRUCT}
}
"@
$bytes=[Text.Encoding]::Unicode.GetBytes($in)
$blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
$c=New-Object BeeziCredW+CREDENTIAL
$c.Type=1; $c.TargetName='${target}'; $c.UserName='${account}'
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2
$ok=[BeeziCredW]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if($ok){'OK'}else{exit 1}`;

// Reads the GENERIC credential back and writes the plaintext secret to stdout; exits non-zero when
// the target is absent (fresh machine, or token stored by the DPAPI fallback instead).
const credRead = (target) => `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);${CRED_STRUCT}
}
"@
$ptr=[IntPtr]::Zero
if(-not [BeeziCredR]::CredRead('${target}',1,0,[ref]$ptr)){exit 1}
$cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][BeeziCredR+CREDENTIAL])
$size=$cred.CredentialBlobSize
if($size -gt 0){
  $bytes=New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$size)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
}
[BeeziCredR]::CredFree($ptr)`;

const credDelete = (target) => `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredD {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[void][BeeziCredD]::CredDelete('${target}',1,0)`;

// The Credential Manager target for a slot. The generation rides in the TARGET, not only in the
// user name: Credential Manager keys on the target, so two generations sharing one target would be
// the same entry — which is exactly the "staged write that overwrote the committed value" this
// design forbids.
function credTarget(service, slot) {
  return slot === '' || slot == null ? service : `${service}:${slot}`;
}

function credManBackend(run, service, timeoutMs) {
  return {
    id: BackendId.CREDMAN,
    label: 'the Windows Credential Manager',
    available: () => true, // advapi32 + PowerShell ship with Windows; failures fall through
    read(slot) {
      return readResultFrom(powershell(run, credRead(credTarget(service, slot)), undefined, timeoutMs));
    },
    write(slot, value) {
      const r = powershell(run, credWrite(credTarget(service, slot), accountForSlot(slot)), value, timeoutMs);
      if (r.timedOut) return { status: WriteStatus.TIMEOUT, where: null };
      return r.ok && r.stdout.trim() === 'OK'
        ? { status: WriteStatus.OK, where: 'the Windows Credential Manager' }
        : { status: WriteStatus.ERROR, where: null };
    },
    remove(slot) {
      const r = powershell(run, credDelete(credTarget(service, slot)), undefined, timeoutMs);
      return { status: r.timedOut ? WriteStatus.TIMEOUT : WriteStatus.OK };
    },
  };
}

function dpapiFileBackend(run, timeoutMs) {
  return {
    id: BackendId.DPAPI_FILE,
    label: 'Windows DPAPI (encrypted at rest)',
    available: () => true, // PowerShell ships with Windows; DPAPI failures fall back below
    read(slot) {
      const r = readFileSlot(slot);
      if (r.obj === undefined) return { status: r.status, value: null };
      if (typeof r.obj.enc === 'string') return readResultFrom(powershell(run, DPAPI_DEC, r.obj.enc, timeoutMs));
      // Plaintext: DPAPI was down when this slot was written, and the file store is the same file.
      return typeof r.obj.token === 'string' && r.obj.token
        ? { status: ReadStatus.OK, value: r.obj.token }
        : { status: ReadStatus.MISSING, value: null };
    },
    write(slot, value) {
      const r = powershell(run, DPAPI_ENC, value, timeoutMs);
      try {
        if (r.ok && r.stdout.trim()) {
          writeJsonSecure(fileForSlot(slot), { enc: r.stdout.trim() });
          return { status: WriteStatus.OK, where: 'Windows DPAPI (encrypted at rest)' };
        }
        writeJsonSecure(fileForSlot(slot), { token: value }); // DPAPI unavailable → plaintext, still 0600
        return { status: WriteStatus.OK, where: 'a restricted local file' };
      } catch {
        return { status: WriteStatus.ERROR, where: null };
      }
    },
    remove: fileDelete,
  };
}

// Preferred backend chain for the platform; the plaintext file is always the tail.
export function backendChain(options = {}) {
  const run = options.run == null ? defaultRun : options.run;
  const platform = options.platform == null ? process.platform : options.platform;
  const timeoutMs = options.timeoutMs == null ? BACKEND_TIMEOUT_MS : options.timeoutMs;
  const service = options.service;
  if (!isSafeKeyringName(service)) {
    // A service name that cannot be safely interpolated must not reach a PowerShell script or an
    // argv element. The file store needs no name at all, so the machine keeps working.
    return [fileBackend()];
  }
  const file = fileBackend();
  if (platform === 'darwin') return [macBackend(run, service, timeoutMs), file];
  if (platform === 'linux') return [secretToolBackend(run, service, timeoutMs), file];
  if (platform === 'win32') return [credManBackend(run, service, timeoutMs), dpapiFileBackend(run, timeoutMs), file];
  return [file];
}

// The chain entry with this id, or null when the platform does not offer it (a store written on
// macOS and read on Linux, or a control record from a machine whose keyring has since gone away).
export function backendById(chain, id) {
  for (const backend of chain) {
    if (backend.id === id) return backend;
  }
  return null;
}
