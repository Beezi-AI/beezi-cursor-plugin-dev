// Strip credentials out of free-text error output before it leaves the machine.
//
// scripts/stop-failure.mjs takes `payload.error ?? payload.tool_output ?? payload.output`, truncates
// it to 2000 characters and POSTs it verbatim as `errorDetails`. That text is the output of a
// command that JUST FAILED, which is precisely where credentials surface: the `curl` that 401'd is
// echoed with its `-H "Authorization: Bearer …"` intact, a failing `psql` prints the connection
// string it tried, a shell that could not find a binary dumps the environment, and a driver error
// quotes the DSN it parsed. None of that is hypothetical — it is the normal content of a failed
// tool call.
//
// ┌─ THE OTHER HALF OF THE JOB, AND THE EASIER ONE TO GET WRONG ─────────────────────────────────┐
// │ A redactor that eats diagnostics is WORSE than no redactor, because the error report still    │
// │ arrives, still looks fine, and is simply useless — and nobody finds out, because the only     │
// │ person who could compare it against the real output is the user who already moved on.         │
// │                                                                                               │
// │ So every rule here is anchored on something that is not plausibly prose: a token's own        │
// │ issuer prefix (`ghp_`, `xoxb-`, `eyJ`), a URL's userinfo colon, or a KEY NAME that contains a │
// │ secret-ish word. Nothing is redacted for merely looking random. A bare 40-character hex string │
// │ is a git SHA far more often than it is a secret, so a bare hex or base64 blob is NEVER        │
// │ touched — only a blob sitting on the right-hand side of a secret-ish key is. The negative      │
// │ table in test/redact.test.mjs is the real specification of this file; add to it before adding │
// │ a rule.                                                                                       │
// └───────────────────────────────────────────────────────────────────────────────────────────────┘

const MASK = '[REDACTED]';

// What stop-failure.mjs already keeps. Exported so the truncation length lives next to the
// redaction that has to happen before it.
export const MAX_DETAIL_CHARS = 2000;

// A key name we treat as secret-bearing. The optional lazy prefix/suffix is what makes one word
// cover the real-world spellings: `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `npm_config__auth`,
// `x-api-key`, `STRIPE_API_KEY`, and a bare `password`.
const KEY = String.raw`[\w.-]{0,60}?(?:secret|token|password|passwd|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth)[\w.-]{0,60}`;

// A value that looks like an encoded credential rather than a word: base64/base64url/hex, long.
// 16 is above every English word that shows up in this position and below every real token.
const BLOB = String.raw`[A-Za-z0-9+/_=-]{16,}`;

// Order matters where one rule would otherwise leave a fragment for the next: the whole-header rule
// runs before the bare-scheme rule, and the self-identifying token shapes run before the key-name
// rules so that a recognised token is masked even when its key name looks innocent.
const RULES = [
  // A PEM block pasted into output (a `cat` of a key file, an SSH or TLS library quoting what it
  // failed to parse). Unambiguous, so the whole block goes. The body is length-bounded: a lazy
  // `[\s\S]*?` with no bound turns a truncated BEGIN with no END into a full scan per occurrence.
  {
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    to: '[REDACTED PRIVATE KEY]',
  },

  // A JWT. `eyJ` is base64 for `{"`, so this is the token announcing its own header — it cannot be
  // an ordinary word. Signature may be empty (alg=none) but the two dots must be there.
  {
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g,
    to: MASK,
  },

  // A whole Authorization header, however it was written — a real HTTP header line, a `-H` argument
  // in an echoed curl, a header dict in a stack trace, or an `Authorization=…` env/log line. Stops
  // at a quote so `-H "Authorization: Bearer x"` keeps its closing quote and stays readable.
  //
  // `=` is accepted as a separator, and that is not cosmetic: without it the unquoted-assignment
  // rule below reached `Authorization=Bearer …` first, matched only as far as the space, and
  // masked the WORD "Bearer" while leaving the credential after it in the report. This rule takes
  // the whole value, so it has to run first and it has to recognise both separators.
  {
    re: /\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n"']+/gi,
    to: `$1${MASK}`,
  },

  // A bare credential after a scheme name, i.e. one that reached the output without its header.
  //
  // Two guards keep this off prose, because "Basic authentication failed" is an ordinary error
  // message and turning it into "Basic [REDACTED] failed" is exactly the diagnostic vandalism this
  // file exists to avoid. First, 16 characters minimum. Second, the credential must contain at
  // least one character that is not a lowercase letter or a hyphen — every real token shape here
  // (base64, base64url, hex) carries uppercase or digits, while the English that follows these two
  // words does not, so "Basic authentication-related failure" is left alone.
  {
    re: /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]{16,})[a-z-]*[A-Z0-9._~+/=][A-Za-z0-9._~+/=-]*/g,
    to: `$1 ${MASK}`,
  },

  // Credentials in a URL's userinfo. The user and the host are KEPT: `postgres://app:[REDACTED]@
  // db.internal:5432/prod` still says who connected to what, which is the entire diagnostic value
  // of the line. Requires `://` so an SSH remote (`git@github.com:org/repo.git`) is untouched, and
  // excludes `/` from both halves so a path like `https://host/a:b@c` is not mistaken for one.
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):[^\s/@]+@/gi,
    to: `$1$2:${MASK}@`,
  },

  // Tokens that carry their issuer's prefix. Each prefix is registered and none of them occurs
  // inside an English word — note `\bsk-` cannot match the `sk-` inside "task-management", because
  // there is no word boundary between "ta" and "sk".
  {
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
    to: MASK,
  },

  // `KEY = "value"` / `"key": "value"` — quoted, so spaces around the separator are allowed. This is
  // the JSON, YAML, TOML and .ini shape.
  {
    re: new RegExp(String.raw`\b(${KEY}"?\s*[:=]\s*)(["'])[^"'\r\n]*\2`, 'gi'),
    to: `$1$2${MASK}$2`,
  },

  // `KEY=value` — unquoted, and the `=` must touch the key. That restriction is load-bearing: V8
  // prints `SyntaxError: Unexpected token = in JSON`, and a rule that allowed spaces would read
  // "token = in" as an assignment and redact the word "in". The value stops at `&`, quotes and
  // angle brackets so a query string keeps its remaining parameters:
  // `?access_token=[REDACTED]&page=2`.
  {
    re: new RegExp(String.raw`\b(${KEY}=)[^\s&"'<>]+`, 'gi'),
    to: `$1${MASK}`,
  },

  // A long encoded blob on the right of a secret-ish key, with a separator that may be spaced —
  // the unquoted YAML/log shape (`api_key: AKIAIOSFODNN7EXAMPLE…`). The blob requirement is what
  // keeps this from firing on `token: expired` or on a stack frame's `auth.js:12:5`.
  {
    re: new RegExp(String.raw`\b(${KEY}"?\s*[:=]\s*)${BLOB}`, 'gi'),
    to: `$1${MASK}`,
  },
];

// Redact `text`. Returns a string; a non-string returns '' rather than being passed through, because
// the one thing a redactor must never do is hand back something it did not inspect.
//
// Idempotent: running it over its own output changes nothing (`[REDACTED]` is shorter than BLOB's
// minimum and contains characters no value pattern accepts).
export function redact(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;
  for (const { re, to } of RULES) out = out.replace(re, to);
  return out;
}

// The stop-failure call site in one function: non-strings become null, the text is redacted, and
// ONLY THEN truncated.
//
// The order is not cosmetic. Truncating first can slice a credential in half and leave the surviving
// half in the report with its anchor gone — a `Bearer` cut from its token, a key name cut from its
// `=`. Redacting first cannot: every rule sees the whole value it is matching.
//
// The working window bounds the cost of that choice. `tool_output` from a failed command can be
// megabytes (a test runner's full log), and a hook has 7500ms for everything it does; the caller
// keeps 2000 characters, so a window 20x larger than the keep runs the rules over everything that
// could possibly survive plus a wide margin, and stops.
const WORK_WINDOW_CHARS = 20 * MAX_DETAIL_CHARS;

export function redactDetail(value, maxChars = MAX_DETAIL_CHARS) {
  if (typeof value !== 'string') return null;
  return redact(value.slice(0, WORK_WINDOW_CHARS)).slice(0, maxChars);
}
