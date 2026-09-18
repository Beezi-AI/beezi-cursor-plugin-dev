// base64url (RFC 4648 §5 / RFC 7515 §2) for the Node floor this plugin declares.
//
// `Buffer.from(x).toString('base64url')` is the obvious spelling and it is NOT available on Node
// 13.2 — the encoding landed in 14.18/15.7. Below that, Node does not throw on an unknown encoding
// name for `toString`: it falls back, so the PKCE verifier and the OAuth `state` came out as
// something the authorization server rejects, on exactly the Node version `package.json` promises
// to support. Encoding through the standard alphabet and substituting afterwards works everywhere.
//
// Encode only. Nothing in this plugin decodes a base64url value: the verifier, the challenge and
// the state are opaque strings it generates, sends and compares.
export function base64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    // Padding is not merely optional in base64url — RFC 7515 §2 forbids it, and Clerk rejects a
    // verifier that carries it.
    .replace(/=+$/, '');
}
