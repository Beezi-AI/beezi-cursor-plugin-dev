// Which MCP server a `beforeMCPExecution` payload is about — derived from the only two fields that
// can say, neither of which is a name.
//
// Cursor's payload is `{ tool_name, tool_input }` (tool_input is a JSON *string*, not an object)
// plus EITHER `{ url }` for a remote server OR `{ command }` for a stdio one. There is no server
// NAME field anywhere in it, and that absence is the entire reason this module exists. The only
// other way to name the server is the flattened `mcp_<server>_<tool>` split that `mcpServerOf` in
// lib/operations-cursor.mjs performs, which is provably wrong for this plugin's own tools:
// `mcp_plugin_beezi_beezi_create_ticket` resolves to a server called "plugin", so every Beezi MCP
// call is attributed to a server that does not exist — and any server whose own name contains an
// underscore is unrecoverable in exactly the same way.
//
// NOTHING HERE IS PERSISTED EXCEPT THE RETURN VALUE, and that is a hard contract rather than a
// convention. The inputs are a URL that can carry a token in its query string and an argv that
// routinely carries one on its command line (`npx some-mcp --api-key sk-…`). The caller writes what
// this returns into the sidecar — a plain-text file that outlives the session, is read back by the
// reporting engine and is uploaded as a `by_server` key. So the scan below skips environment
// assignments, skips the value of any flag whose NAME mentions a credential, and rejects a
// candidate shaped like a secret. Each of those is a way an unlucky command line would otherwise
// turn a telemetry log into a secret store.
//
// NULL IS A VALID, HONEST ANSWER — and it is the answer for every localhost server with a generic
// path, every shell-wrapped launch, and every command that is only flags. The joiner in
// lib/operations-cursor.mjs falls back to the prefix split when this returns null, so a null costs
// exactly what the plugin already had and never asserts something we did not observe.
//
// `tool_name` is accepted for symmetry with the payload and deliberately NEVER read: inferring the
// server from it is precisely the broken prefix split this exists to replace, and doing it here
// would only make the same wrong answer look like an observation.
//
// Zero dependencies, and NEVER THROWS. The one caller is a PERMISSION hook — `beforeMCPExecution` is
// the event whose stdout Cursor reads as a permission decision — so a throw here becomes a stack
// trace in Cursor's execution log on every MCP call the user makes.

// The `by_server` keys are report dimensions, so an unbounded one is a table column of arbitrary
// width. 64 is generous for a package name and short enough that a pathological argv token cannot
// become a row label.
const MAX_SERVER_CHARS = 64;

// Hostnames that name the MACHINE rather than the service. A `by_server` key of "localhost" tells a
// user nothing and merges every local server they run into a single row, so these fall through to
// the URL path instead.
const LOCAL_HOSTS = new Set(['localhost', 'ip6-localhost', '0.0.0.0', 'host.docker.internal']);

// Path segments every MCP transport uses, in every deployment, for every server. `/mcp`, `/sse` and
// `/v1/messages` are the transport, not the product — naming a server "sse" would be worse than
// naming it nothing, because a wrong name looks observed while a null routes to the fallback.
const TRANSPORT_SEGMENTS = new Set([
  'mcp',
  'mcp-server',
  'sse',
  'stream',
  'streamable',
  'streamable-http',
  'http',
  'ws',
  'api',
  'rpc',
  'jsonrpc',
  'message',
  'messages',
  'events',
  'v1',
  'v2',
  'v3',
]);

// Everything a stdio MCP server is launched THROUGH rather than named by. Compared against the
// token's basename with a file extension stripped, so `/usr/local/bin/node` and
// `C:\Program Files\nodejs\node.exe` are both recognised as the runner they are.
const RUNNERS = new Set([
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bunx',
  'bun',
  'dlx',
  'exec',
  'uvx',
  'uv',
  'pipx',
  'node',
  'nodejs',
  'deno',
  'python',
  'python3',
  'py',
  'dotnet',
  'docker',
  'podman',
  'env',
  'run',
]);

// A shell means the real command is inside a quoted string — `sh -c "uvx mcp-server-git"` — and
// that string is a PROGRAM, not an argv. Parsing programs is how a command reader grows a parser
// (see the note in lib/hook-input-cursor.mjs about Codex's `tool_input`), and half-parsing one here
// would return "sh" or the first word of a pipeline as a server name. Null instead: the joiner's
// fallback is right more often than a guess at shell syntax would be.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'powershell', 'pwsh']);

// `FOO=bar cmd …` — a value that is a configuration secret about as often as it is not. Skipped
// before anything else looks at it.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// A flag whose VALUE is the thing we are looking for: `python3 -m some_module`. The token after one
// of these is the candidate outright, with no further scanning.
//
// `-m` is NOT in here, and the omission is deliberate: it means "module" to python and "memory
// limit" to docker, so an unconditional reading of it turns `docker run -m 512m … mcp/filesystem`
// into a server called "512m". It is promoted to a target flag only after a python runner has
// actually been seen — see `sawPython` below. `-p` is worse still (npx's "package" against docker's
// "publish port") and is not promoted at all: for `npx -p @scope/tools mcp-thing` the command name
// that follows is a perfectly good server name anyway.
const TARGET_FLAGS = new Set(['--module', '--package']);
const PYTHON_RUNNERS = new Set(['python', 'python3', 'py']);

// A flag whose NAME says its value is a credential. Its value is skipped along with it, because
// `npx --api-key sk-live-… some-mcp` would otherwise offer `sk-live-…` as the candidate the moment
// the package name moved after it. Deliberately generous — a missed server name costs a fallback,
// a leaked key costs a rotation.
// `pat` is bounded because it is a substring of `--path`, which is an ordinary flag whose value is
// exactly the script path we are looking for; the rest are safe as substrings.
const SECRET_FLAG =
  /(key|token|secret|password|passwd|auth|credential|cred|bearer|header|cookie|(^|[^a-z])pat([^a-z]|$))/i;

// Flags whose value is real, unremarkable configuration that is nonetheless NOT the server's name.
// `docker run … -e GITHUB_TOKEN ghcr.io/github/github-mcp-server` is the shape that forced this:
// without it the scan stops on `GITHUB_TOKEN` — a variable name, not a value, so not a leak, but a
// `by_server` row called GITHUB_TOKEN is still a wrong answer that looks observed. Everything here
// is a flag whose value would otherwise be mistaken for a package or a script path.
const VALUE_FLAGS = new Set([
  '-m',
  '-p',
  '-e',
  '--env',
  '-v',
  '--volume',
  '--mount',
  '-w',
  '--workdir',
  '--directory',
  '--cwd',
  '--config',
  '--project',
  '--network',
  '--user',
  '-u',
  '--label',
  '-l',
  '--name',
  '--host',
  '--port',
  '--from',
  '--with',
  '--loader',
  '--require',
  '-r',
]);

// Known script/binary extensions, stripped from a script path so `/opt/mcp/weather.mjs` reports as
// "weather". Only KNOWN ones: an unknown dotted tail is far more likely to be a python module path
// (`mcp.server.git`) than an extension, and cutting that would lose the name entirely.
const SCRIPT_EXTENSIONS = new Set([
  'mjs',
  'cjs',
  'js',
  'ts',
  'mts',
  'cts',
  'py',
  'pyz',
  'rb',
  'sh',
  'php',
  'pl',
  'jar',
  'exe',
  'bat',
  'cmd',
  'com',
]);

// What a package, image or script name looks like. Must START alphanumeric, which is what rejects a
// stray flag, a quote, a shell metacharacter and a leftover `@scope` with no name after it.
const SERVER_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/;

// The shape of a credential, as a last line of defence behind SECRET_FLAG and ENV_ASSIGNMENT. The
// prefixes are the published ones for the tokens most likely to be sitting on an MCP command line;
// the length rule catches the rest, because a package name is not 24 characters of mixed case with
// digits mixed in and a real one that is loses only to the fallback.
const SECRET_PREFIX = /^(sk|pk|rk|ghp|gho|ghu|ghs|ghr|glpat|github_pat|xox[abceoprs]|akia|asia)[-_]/i;
const JWT_PREFIX = /^eyJ/;

function looksLikeSecret(value) {
  if (SECRET_PREFIX.test(value) || JWT_PREFIX.test(value)) return true;
  return value.length >= 24 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

// The last gate before a string becomes a report dimension. Everything that returns a name goes
// through here, so the charset, the length cap and the secret check cannot be bypassed by adding a
// derivation path later.
function clean(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, MAX_SERVER_CHARS).trim();
  if (name === '' || !SERVER_SHAPE.test(name)) return null;
  if (looksLikeSecret(name)) return null;
  return name;
}

function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return SCRIPT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? name.slice(0, dot) : name;
}

// The last path segment of a token, which is also what strips an npm scope: `@scope/name` and
// `/abs/path/name` are the same cut. Backslashes count as separators too — a Windows MCP config
// carries `C:\Users\me\servers\weather.mjs` and splitting only on `/` would report the whole path.
function basename(token) {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return cut === -1 ? token : token.slice(cut + 1);
}

// `@scope/server-github@0.6.2` → `server-github`, `ghcr.io/org/img:sha-abc` → `img`,
// `/opt/mcp/weather.mjs` → `weather`. A version or a docker tag is not part of the server's
// identity: leaving it on would open a new `by_server` row on every upgrade of the same server.
function packageName(token) {
  let name = basename(token);
  const version = name.indexOf('@', 1);
  if (version > 0) name = name.slice(0, version);
  const tag = name.indexOf(':');
  if (tag > 0) name = name.slice(0, tag);
  return stripExtension(name);
}

// Split an argv the way a shell would, minus the parts a launch command never uses.
//
// NO BACKSLASH ESCAPES, deliberately. Every Windows MCP config in existence writes
// `"C:\Users\me\servers\weather.mjs"`, and treating `\U` as an escape would silently eat the path
// separators of exactly the platform this plugin is developed on. Quotes group, whitespace splits,
// nothing else is interpreted.
function tokenize(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let open = false;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (open || current !== '') tokens.push(current);
      current = '';
      open = false;
      continue;
    }
    current += ch;
  }
  if (open || current !== '') tokens.push(current);
  return tokens;
}

// A remote server: the host is the identity, unless the host is this machine.
function serverFromUrl(raw) {
  const text = raw.trim();
  if (text === '') return null;
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(text);
    host = parsed.hostname;
    // `pathname` only — never `search`. A remote MCP endpoint's query string is where an API key
    // lives when the transport has nowhere else to put one.
    pathname = parsed.pathname;
  } catch {
    /* handled below, together with the parses that succeed and mean nothing */
  }
  if (host === '') {
    // Either `new URL` threw (a scheme-less `mcp.example.com/sse`) or it "succeeded" and named
    // nothing — `new URL('localhost:3000/mcp')` parses with protocol `localhost:` and an EMPTY
    // hostname, so trusting the parse would read the port as a path segment and report a server
    // called "3000". Strip scheme, userinfo (`user:pass@`), port, query and fragment by hand.
    const afterScheme = text.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
    const slash = afterScheme.indexOf('/');
    const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
    pathname = (slash === -1 ? '' : afterScheme.slice(slash)).split(/[?#]/)[0];
    const at = authority.lastIndexOf('@');
    host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:\d+$/, '');
  }

  host = host.toLowerCase().replace(/^www\./, '');
  if (host !== '' && !namesAMachine(host)) return clean(host);

  // The host named the machine, so the service can only be in the path. Skip the segments every
  // transport uses and take the first that says something.
  for (const segment of pathname.split('/')) {
    const seg = segment.trim().toLowerCase();
    if (seg === '' || TRANSPORT_SEGMENTS.has(seg)) continue;
    const name = clean(stripExtension(seg));
    if (name !== null) return name;
  }
  return null;
}

function namesAMachine(host) {
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  // Any bare IPv4 literal, not just 127.x: a `by_server` key of "10.0.0.5" is a lease, not a name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // `new URL` hands IPv6 back bracketed; the hand-rolled branch may not.
  return host.startsWith('[') || host.includes(':');
}

// A stdio server: walk the argv past everything that launches it to the thing that IS it.
function serverFromCommand(command) {
  const tokens = Array.isArray(command)
    ? // Cursor documents `command` as a string. An array is accepted because some hosts hand an
      // argv straight through and a shape check that throws on one would take the hook with it.
      command.filter((token) => typeof token === 'string')
    : typeof command === 'string'
      ? tokenize(command)
      : [];

  let skipValue = false;
  let takeNext = false;
  let sawPython = false;
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === '') continue;

    // The value of a flag we decided not to read. Only ever consumed when it is not itself a flag,
    // so a valueless `--token-mode --package x` does not swallow the flag that follows it.
    if (skipValue && !token.startsWith('-')) {
      skipValue = false;
      continue;
    }
    skipValue = false;

    if (takeNext) return clean(packageName(token));
    if (ENV_ASSIGNMENT.test(token)) continue;

    if (token.startsWith('-')) {
      if (TARGET_FLAGS.has(token) || (token === '-m' && sawPython)) takeNext = true;
      // `--flag=value` carries its value with it, so the next token is still eligible. Only the
      // separated form can steal the candidate slot.
      else if (!token.includes('=')) skipValue = VALUE_FLAGS.has(token) || SECRET_FLAG.test(token);
      continue;
    }

    const base = stripExtension(basename(token)).toLowerCase();
    if (RUNNERS.has(base)) {
      if (PYTHON_RUNNERS.has(base)) sawPython = true;
      continue;
    }
    if (SHELLS.has(base)) return null;
    return clean(packageName(token));
  }
  return null;
}

// The server behind one `beforeMCPExecution` payload, or null when nothing meaningful can be
// derived from it. See the header: null is an answer, and the caller has a fallback for it.
export function mcpServerFrom(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null;
    let url = payload.url;
    if (url == null) url = payload.serverUrl;
    if (url == null) url = payload.server_url;
    if (typeof url === 'string') {
      const fromUrl = serverFromUrl(url);
      if (fromUrl !== null) return fromUrl;
    }
    // Tried even when a `url` was present and unusable: the two fields are documented as exclusive,
    // so reading both costs one type check and survives a payload that carries them together.
    return serverFromCommand(payload.command);
  } catch {
    // Unreachable by design, and caught anyway. The caller is a permission hook; see the header.
    return null;
  }
}
