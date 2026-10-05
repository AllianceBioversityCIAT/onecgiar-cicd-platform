// @akili-spec changes/cicd-executor-poc design §12 (observability/security row); requirements FR-17
//
// Secret-pattern redaction for the JSON logger. Design §12: "the logger's
// redaction covers tokens, `password`, `secret`, PEM keys and presigned
// URLs." Applied to every log record before it is serialized: field values,
// nested objects and message strings alike (FR-17's redaction scenario:
// "GIVEN any log THEN it contains no secrets, credentials, or tokens").
//
// Pure, no I/O. Two complementary strategies, deliberately combined:
//   1. Pattern matching on string content (`redactString`) — catches a
//      secret embedded anywhere in a message or field value, regardless of
//      which key (if any) it sits under: any `Authorization` scheme (not
//      only Bearer), SigV4/SigV2 `Signature=` fragments wherever they occur,
//      `password=`/`secret:`/`token=`/`apiKey:`-shaped fragments (key as a
//      prefix/suffix, e.g. `db_password`, `clientSecret`, `accessToken`,
//      `api_key`, including JSON-quoted keys), AWS-style access key ids
//      (temporary `ASIA...` included), PEM private key blocks (full or
//      truncated — no `END` marker required), presigned-URL /
//      security-token header parameters, URL-embedded basic-auth
//      credentials (`scheme://user:PASSWORD@host`), and GitHub tokens
//      (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).
//   2. Key-name matching on object fields (`isSensitiveKey`) — catches a
//      secret value that carries no recognizable prefix of its own (e.g. a
//      bare `{ password: "hunter2" }` or `{ token: "..." }` field, of any
//      value type, not only strings), which pattern matching alone cannot
//      see. Deliberately exempts `dispatchToken`/`fencingToken`/
//      `idempotencyToken`/`nextToken`: those are correlation/pagination
//      ids, not secrets (design DD-04: `idempotencyToken = dispatchToken`),
//      and FR-17's reconstruction scenario depends on them surviving
//      redaction.
//
// Rework (attempt 3, reviewer round 2): the disqualifier was "a corpus
// missing any listed secret type doesn't prove its redaction" — the string
// pattern only covered `password`/`secret` key/value shapes, not `token`s
// embedded in string content (bare `token=`/`api_key=`, JSON-quoted
// `"accessToken":"..."`, the `X-Amz-Security-Token:` header form, and
// `ghs_`/`github_pat_` GitHub tokens, which the old pattern missed). Also
// fixed: `redactValue` had no cycle guard (a cyclic object crashed the
// logger with `RangeError: Maximum call stack size exceeded` instead of
// producing the "why it failed" record FR-17 needs); `idempotencyToken` and
// `nextToken` were wrongly redacted despite being correlation/pagination
// ids, not secrets (DD-04); `Error.cause`/`AggregateError.errors` were not
// recursed into; an ARN like `arn:aws:secretsmanager:...` was over-redacted
// because `secretsmanager` was mistaken for a `secret`-prefixed key; a
// SigV4 `Signature=` inside an `Authorization: AWS4-HMAC-SHA256 ...` header
// (and a bare SigV2 presigned `Signature=` query param) survived; and a URL
// with embedded basic-auth credentials leaked the password.
const REDACTED = "[REDACTED]";

/** Correlation/pagination identifiers that look like a token but are not secrets (design §12 / FR-17's reconstruction scenario depends on them surviving redaction; DD-04: `idempotencyToken = dispatchToken`). */
const EXEMPT_KEYS = new Set(["dispatchtoken", "fencingtoken", "idempotencytoken", "nexttoken"]);

/** Field names redacted outright as a whole normalized key (design §12: "password", "secret", "tokens"). */
const SENSITIVE_KEY_EXACT = new Set(["authorization", "privatekey", "secretaccesskey"]);

/** Field names redacted outright when the normalized (lower-cased, separator-stripped) key ends with one of these — covers prefixed/suffixed variants (`db_password`, `clientSecret`, `sessionToken`, `apiKey`, `cookie`, …). */
const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "secret",
  "token",
  "passphrase",
  "apikey",
  "passwd",
  "pwd",
  "cookie",
  "sshkey",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether an object field name should be redacted outright, regardless of its value's shape or type. */
function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (EXEMPT_KEYS.has(normalized)) {
    return false;
  }
  if (SENSITIVE_KEY_EXACT.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** A PEM private-key block of any kind (`PRIVATE KEY`, `RSA PRIVATE KEY`, …): from `BEGIN` through a matching `END`, or through the end of the string when the block was truncated (e.g. a cut-off stderr tail) and never reached `END`. */
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g;

/** A presigned URL's secret-bearing parameter, as either a query param (`X-Amz-Security-Token=value`) or a header (`X-Amz-Security-Token: value`): the signature, the temporary security token, and the credential scope (which embeds the temporary access key id). Redacts only the value, keeping the parameter name and its original delimiter visible. */
const PRESIGNED_URL_SENSITIVE_PARAM_PATTERN =
  /(X-Amz-(?:Signature|Security-Token|Credential))(\s*[:=]\s*)[^&\s"',}]+/gi;

/** `Authorization: <scheme> <value>` — any scheme (Basic, Bearer, Digest, AWS4-HMAC-SHA256, …), not only Bearer. Keeps the scheme visible, redacts only the credential value (the first whitespace-delimited token after it — a SigV4 header's trailing `Signature=...` is caught separately by `BARE_SIGNATURE_PARAM_PATTERN`, since the credential value here is itself a comma-separated list). */
const AUTHORIZATION_HEADER_PATTERN = /("?Authorization"?\s*[:=]\s*"?)([A-Za-z][\w.~+-]*)(\s+)([^\s"',}]+)/gi;

/** A bare `Bearer <token>` fragment with no preceding `Authorization` keyword. */
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** A standalone `Signature=value` fragment wherever it occurs — a SigV4 `Authorization` header's trailing signature, or a SigV2 presigned URL's `Signature` query param (the `X-Amz-` prefixed form is already covered by `PRESIGNED_URL_SENSITIVE_PARAM_PATTERN`; this one is idempotent against that case). */
const BARE_SIGNATURE_PARAM_PATTERN = /\bSignature=[^&\s"',}]+/gi;

/** A URL with embedded basic-auth credentials (`scheme://user:PASSWORD@host`). Keeps the scheme and user visible, redacts only the password. */
const URL_CREDENTIALS_PATTERN = /(:\/\/[^\s:/@]+:)([^@\s]+)(@)/g;

/** A GitHub token of any current prefix (`ghp_` personal, `gho_` OAuth, `ghu_`/`ghs_` app installation/server, `ghr_` refresh) or the newer `github_pat_` fine-grained form. Checked before the generic key/value pattern so its `_`-separated body is never mistaken for a delimiter. */
const GITHUB_TOKEN_PATTERN = /gh[opusr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/g;

/** An AWS-style access key id: permanent (`AKIA`) or temporary (`ASIA`, NFR-02's temporary-credentials case) + 16 upper-case alphanumerics. */
const AWS_ACCESS_KEY_ID_PATTERN = /(?:AKIA|ASIA)[0-9A-Z]{16}/g;

/**
 * The sensitive-key vocabulary matched inside arbitrary string content (not
 * only object field names): `password`/`secret` (design §12's named
 * categories), `token`/`apikey`/`api_key`/`authorization` (design §12's
 * "tokens" category — covers a token leaked verbatim in a message, a
 * JSON-quoted key in a stringified error body, etc.), and the advisory
 * additions `passwd`/`pwd`/`cookie`/`sshkey`. `secret` excludes the AWS
 * service name `secretsmanager` (as in `arn:aws:secretsmanager:...`) via a
 * negative lookahead — that word is a service identifier, not a secret-value
 * key, and matching it was over-redacting the rest of the ARN.
 */
const SENSITIVE_STRING_KEY_FRAGMENT =
  "(?:password|secret(?!smanager)|token|api[-_]?key|authorization|passwd|pwd|cookie|sshkey)";

/**
 * `password=value` / `db_password: "value"` / `"clientSecret": "two words"` /
 * `"accessToken":"AT..."` / `token=SUPERSECRETTOK` — the key may carry a
 * prefix or suffix (not only the bare word) and may be JSON-quoted, and the
 * value is redacted through its closing quote when quoted, or up to the next
 * delimiter when bare. Group 1 is the whole prefix (quote/key/quote/
 * delimiter) reused verbatim in the replacement; group 2 nests just the key
 * text (no quotes) so the replacer can exempt `dispatchToken`/
 * `fencingToken`/`idempotencyToken`/`nextToken` (the same correlation-id
 * exemptions `isSensitiveKey` applies to object fields) from being mangled
 * when they appear as string content, e.g. inside a pretty-printed payload.
 */
const KEY_VALUE_SECRET_PATTERN = new RegExp(
  `("?([A-Za-z_]*${SENSITIVE_STRING_KEY_FRAGMENT}[A-Za-z_]*)"?\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s,}]+))`,
  "gi",
);

function redactKeyValuePairs(input: string): string {
  return input.replace(
    KEY_VALUE_SECRET_PATTERN,
    (match, prefix: string, key: string, dq?: string, sq?: string, _bare?: string) => {
      if (EXEMPT_KEYS.has(normalizeKey(key))) {
        return match;
      }
      if (dq !== undefined) {
        return `${prefix}"${REDACTED}"`;
      }
      if (sq !== undefined) {
        return `${prefix}'${REDACTED}'`;
      }
      return `${prefix}${REDACTED}`;
    },
  );
}

/**
 * Redacts every recognized secret pattern out of a single string. Order:
 * whole-block patterns first (PEM), then parameter/header patterns that must
 * see their original key name before any value-only pattern could touch it
 * (presigned URL params/headers, `Authorization: <scheme>`), then the
 * standalone-signature, bare-Bearer, URL-credentials, and token-literal
 * patterns, then the generic password/secret/token key/value pattern last
 * (narrowest, so it never pre-empts a more specific match).
 */
export function redactString(input: string): string {
  let out = input;
  out = out.replace(PEM_PRIVATE_KEY_PATTERN, REDACTED);
  out = out.replace(
    PRESIGNED_URL_SENSITIVE_PARAM_PATTERN,
    (_match, paramName: string, delimiter: string) => `${paramName}${delimiter}${REDACTED}`,
  );
  out = out.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (_match, prefix: string, scheme: string, space: string) => `${prefix}${scheme}${space}${REDACTED}`,
  );
  out = out.replace(BARE_SIGNATURE_PARAM_PATTERN, `Signature=${REDACTED}`);
  out = out.replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`);
  out = out.replace(URL_CREDENTIALS_PATTERN, (_match, prefix: string, _password: string, at: string) => `${prefix}${REDACTED}${at}`);
  out = out.replace(GITHUB_TOKEN_PATTERN, REDACTED);
  out = out.replace(AWS_ACCESS_KEY_ID_PATTERN, REDACTED);
  out = redactKeyValuePairs(out);
  return out;
}

/** Normalizes an `Error` into a plain object carrying its `name`, `message`, `stack` (own, non-enumerable by default — lost by a plain object walk, FR-17's reconstruction scenario needs "why it failed"), any own enumerable extra properties (e.g. a `.code`, or an accidentally-attached secret), and — when present — its `cause` (own but non-enumerable per the Error-cause proposal, so `Object.keys` alone misses it) and an `AggregateError`'s `errors` array, both recursed into by the caller like any other field. */
function normalizeError(error: Error): Record<string, unknown> {
  const ownProps: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    ownProps[key] = (error as unknown as Record<string, unknown>)[key];
  }
  const out: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack, ...ownProps };
  if ("cause" in error) {
    out.cause = (error as Error & { cause?: unknown }).cause;
  }
  const maybeAggregate = error as Error & { errors?: unknown };
  if (Array.isArray(maybeAggregate.errors)) {
    out.errors = maybeAggregate.errors;
  }
  return out;
}

/**
 * Deep-redacts an arbitrary log value: strings are pattern-scanned
 * (`redactString`), arrays are mapped over, `Date` instances pass through
 * unchanged (not secrets, and recursing would destroy their `toJSON`
 * serialization), `Error` instances are normalized (above, including
 * `cause`/`errors`) and then redacted recursively, and any other non-null
 * object — plain, class instance, or null-prototype alike — is walked by its
 * own enumerable keys, redacting each field whose key matches
 * `isSensitiveKey` outright (regardless of that field's value type: string,
 * number, object, …). Anything else (numbers, booleans, null, undefined,
 * bigints, etc.) passes through unchanged.
 *
 * A `WeakSet` tracks the objects/arrays/errors currently on the recursion
 * path (added before recursing into their contents, removed once that
 * recursion returns): a value re-encountered while still on that path is a
 * genuine cycle (e.g. `error.cause === error`, or a Lambda/SDK error object
 * with a back-reference) and is replaced with the string `"[Circular]"`
 * instead of recursing forever and crashing with `RangeError: Maximum call
 * stack size exceeded` — an SDK/HTTP error on a failure path must still
 * produce the "why it failed" record (FR-17's reconstruction scenario), not
 * throw from the logger call itself. The same object reached twice via two
 * *different*, non-overlapping branches (not a cycle, just a shared
 * reference) is still fully redacted both times, since the object is removed
 * from the set as soon as its own branch finishes.
 */
export function redactValue(value: unknown): unknown {
  return redactWithCycleGuard(value, new WeakSet<object>());
}

function redactWithCycleGuard(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return value.map((item) => redactWithCycleGuard(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Error) {
    seen.add(value);
    try {
      return redactWithCycleGuard(normalizeError(value), seen);
    } finally {
      seen.delete(value);
    }
  }
  seen.add(value);
  try {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const fieldValue = (value as Record<string, unknown>)[key];
      out[key] = isSensitiveKey(key) ? REDACTED : redactWithCycleGuard(fieldValue, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
