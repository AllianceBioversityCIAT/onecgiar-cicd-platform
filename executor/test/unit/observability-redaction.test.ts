// @akili-spec changes/cicd-executor-poc design §12 (observability/security row); requirements FR-17 (redaction)
//
// Proves FR-17's redaction scenario ("GIVEN any log THEN it contains no
// secrets, credentials, or tokens") against a corpus of fake secrets, one
// pattern per listed category (design §12: "tokens, password, secret, PEM
// keys, presigned URLs"). Each fixture is an obviously fake value (never a
// real credential) run through `redactValue`, which the logger (T-17) calls
// on every field, nested object and message string before serializing a log
// line.
//
// Rework (attempt 2): the disqualifier is "a corpus missing any listed
// secret type doesn't prove its redaction" — this corpus was extended per
// the reviewer's round-1 report with the rows that exposed each gap: a
// temp-credentials presigned URL (security token + credential scope, not
// only the signature), key-only token/authorization fields (with the
// `dispatchToken`/`fencingToken` exemptions proven alongside them so the
// fix isn't "redact every token-shaped key"), a truncated PEM block with no
// `END` marker, a `db_password`/`clientSecret`-shaped key as a string
// fragment (not only the bare word), a quoted multi-word value, an
// `Authorization: Basic` header (not only Bearer), an `Error` instance with
// a secret in its message and stack, a null-prototype object, a non-string
// value under a sensitive key, and a nested array of objects.
//
// Rework (attempt 3, reviewer round 2): the disqualifier fired again — the
// "tokens" category had no corpus row for a token embedded in *string*
// content (as opposed to an object field name), so a token leaked verbatim
// inside a message, a JSON-stringified SDK error body, or a header survived
// unnoticed. Added rows for: a bare `token=`/`api_key=` fragment, a
// JSON-quoted `"accessToken":"..."` fragment (an STS/HTTP error body logged
// as a string), the `X-Amz-Security-Token:` header form (colon, not only
// `=`), and `ghs_`/`github_pat_` GitHub tokens (previously only `ghp_`
// matched). Also added: `idempotencyToken`/`nextToken` exemption proof
// (DD-04: `idempotencyToken = dispatchToken`, a correlation id, not a
// secret; `nextToken` is AWS pagination), a cyclic-object proof (the
// `WeakSet` cycle guard), an `Error.cause`/`AggregateError.errors` proof, an
// ARN-over-redaction fix proof (`arn:aws:secretsmanager:...` must not be
// mistaken for a `secret`-prefixed key), a SigV4 `Authorization` header's
// trailing `Signature=` and a SigV2 presigned URL's bare `Signature=`, and a
// URL with embedded basic-auth credentials.
import { describe, expect, it } from "vitest";
import { redactValue } from "../../src/observability/logger/redaction.js";

const FAKE_BEARER_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.signature";
const FAKE_PASSWORD_VALUE = "hunter2-fake-password";
const FAKE_SECRET_VALUE = "super-fake-secret-value";
const FAKE_AWS_ACCESS_KEY_ID = "AKIAFAKEACCESSKEYID1"; // obviously-fake, AKIA + 16 upper-case-alnum chars shape
const FAKE_AWS_TEMP_ACCESS_KEY_ID = "ASIAFAKEACCESSKEYID9"; // obviously-fake, temporary (ASIA) shape — NFR-02
const FAKE_PEM_KEY_BODY = "MIIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const FAKE_PEM_BLOCK = `-----BEGIN PRIVATE KEY-----\n${FAKE_PEM_KEY_BODY}\n-----END PRIVATE KEY-----`;
const FAKE_TRUNCATED_PEM_BODY = "MIIFAKETRUNCATEDFAKETRUNCATEDFAKETRUNCATED";
const FAKE_PRESIGNED_URL =
  "https://fake-bucket.s3.amazonaws.com/fake-key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=fakefakefakefakefakefakefakefakefakefake0123";
const FAKE_PRESIGNED_SIGNATURE = "fakefakefakefakefakefakefakefakefakefake0123";
const FAKE_SECURITY_TOKEN = "SEC-TOKEN-LEAK-FAKE-0123456789";
const FAKE_CREDENTIAL_SCOPE = `${FAKE_AWS_TEMP_ACCESS_KEY_ID}/20261005/us-east-1/s3/aws4_request`;
const FAKE_TEMP_CREDENTIALS_PRESIGNED_URL =
  `https://fake-bucket.s3.amazonaws.com/fake-key?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
  `&X-Amz-Credential=${FAKE_CREDENTIAL_SCOPE}` +
  `&X-Amz-Security-Token=${FAKE_SECURITY_TOKEN}` +
  `&X-Amz-Signature=abcfakefakefakefake`;
const FAKE_GITHUB_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123";
const FAKE_GITHUB_SERVER_TOKEN = "ghs_FAKESERVERTOKENFAKESERVERTOKEN0123";
const FAKE_GITHUB_PAT = "github_pat_FAKEFAKEFAKEFAKEFAKEFAKEFAKE_FAKEFAKEFAKEFAKEFAKEFAKE";
const FAKE_BASIC_AUTH_VALUE = "ZmFrZTpmYWtlLWJhc2ljLWF1dGg"; // obviously-fake base64, not a real credential
const FAKE_DB_PASSWORD_VALUE = "fake-db-password-leak";
const FAKE_CLIENT_SECRET_VALUE = "fake-client-secret-leak";
const FAKE_MULTI_WORD_PASSWORD = "two fake words";
const FAKE_BARE_TOKEN_VALUE = "SUPERSECRETTOK";
const FAKE_API_KEY_VALUE = "APIKEYSECRET";
const FAKE_JSON_ACCESS_TOKEN = "AT-FAKE-ACCESS-TOKEN-0123456789";
const FAKE_JSON_SESSION_TOKEN = "ST-FAKE-SESSION-TOKEN-0123456789";
const FAKE_SECURITY_TOKEN_HEADER_VALUE = "HEADER-TOK-FAKE-0123456789";
const FAKE_SIGV4_SIGNATURE = "fakefakefakefakefakefakefakefakefakesigv4";
const FAKE_SIGV2_SIGNATURE = "fakefakefakefakefakefakesigv2plus%3D";
const FAKE_URL_PASSWORD = "fake-url-password-leak";

/** One row per design §12 redaction category; each `raw` is a realistic log fragment containing the fake secret. */
const CORPUS: ReadonlyArray<{ readonly category: string; readonly raw: string; readonly secret: string }> = [
  { category: "bearer token", raw: `Authorization header: ${FAKE_BEARER_TOKEN}`, secret: FAKE_BEARER_TOKEN },
  { category: "password=", raw: `connecting with password=${FAKE_PASSWORD_VALUE}`, secret: FAKE_PASSWORD_VALUE },
  { category: '"secret":', raw: `payload was {"secret": "${FAKE_SECRET_VALUE}"}`, secret: FAKE_SECRET_VALUE },
  {
    category: "AWS access key id (permanent, AKIA)",
    raw: `using access key ${FAKE_AWS_ACCESS_KEY_ID} for this call`,
    secret: FAKE_AWS_ACCESS_KEY_ID,
  },
  {
    category: "AWS access key id (temporary, ASIA — NFR-02)",
    raw: `using temporary access key ${FAKE_AWS_TEMP_ACCESS_KEY_ID} for this call`,
    secret: FAKE_AWS_TEMP_ACCESS_KEY_ID,
  },
  { category: "PEM private key block (complete)", raw: `host key material:\n${FAKE_PEM_BLOCK}`, secret: FAKE_PEM_KEY_BODY },
  {
    category: "PEM private key block (truncated, no END marker)",
    raw: `stderr tail (cut off): -----BEGIN RSA PRIVATE KEY-----\n${FAKE_TRUNCATED_PEM_BODY}`,
    secret: FAKE_TRUNCATED_PEM_BODY,
  },
  { category: "presigned URL (X-Amz-Signature)", raw: `uploaded to ${FAKE_PRESIGNED_URL}`, secret: FAKE_PRESIGNED_SIGNATURE },
  {
    category: "presigned URL with temporary credentials (X-Amz-Credential, X-Amz-Security-Token — NFR-02)",
    raw: `uploaded to ${FAKE_TEMP_CREDENTIALS_PRESIGNED_URL}`,
    secret: FAKE_SECURITY_TOKEN,
  },
  { category: "GitHub token (ghp_)", raw: `cloning with token ${FAKE_GITHUB_TOKEN}`, secret: FAKE_GITHUB_TOKEN },
  {
    category: "Authorization: Basic (not only Bearer)",
    raw: `request failed, Authorization: Basic ${FAKE_BASIC_AUTH_VALUE}`,
    secret: FAKE_BASIC_AUTH_VALUE,
  },
  {
    category: "db_password= (key as a suffix, not only the bare word)",
    raw: `connecting with db_password=${FAKE_DB_PASSWORD_VALUE}`,
    secret: FAKE_DB_PASSWORD_VALUE,
  },
  {
    category: "clientSecret= (key as a prefix, not only the bare word)",
    raw: `oauth exchange failed: clientSecret=${FAKE_CLIENT_SECRET_VALUE}`,
    secret: FAKE_CLIENT_SECRET_VALUE,
  },
  {
    category: "password: \"multi word value\" (quoted value redacted through the closing quote)",
    raw: `config dump: password: "${FAKE_MULTI_WORD_PASSWORD}"`,
    secret: FAKE_MULTI_WORD_PASSWORD,
  },
  {
    category: "token= inside a plain message string (reviewer round 2: 'tokens' not covered inside string content)",
    raw: `calling with token=${FAKE_BARE_TOKEN_VALUE} and api_key=${FAKE_API_KEY_VALUE}`,
    secret: FAKE_BARE_TOKEN_VALUE,
  },
  {
    category: "api_key= inside the same message (companion row to the one above)",
    raw: `calling with token=${FAKE_BARE_TOKEN_VALUE} and api_key=${FAKE_API_KEY_VALUE}`,
    secret: FAKE_API_KEY_VALUE,
  },
  {
    category: 'JSON string body {"accessToken":"...","sessionToken":"..."} (e.g. a stringified STS/HTTP error body)',
    raw: `error body: {"accessToken":"${FAKE_JSON_ACCESS_TOKEN}","sessionToken":"${FAKE_JSON_SESSION_TOKEN}"}`,
    secret: FAKE_JSON_ACCESS_TOKEN,
  },
  {
    category: "X-Amz-Security-Token: TOK (header colon form, not only the query-param = form)",
    raw: `request headers: X-Amz-Security-Token: ${FAKE_SECURITY_TOKEN_HEADER_VALUE}`,
    secret: FAKE_SECURITY_TOKEN_HEADER_VALUE,
  },
  {
    category: "GitHub server-to-server token (ghs_, only ghp_ was matched before)",
    raw: `installation token ${FAKE_GITHUB_SERVER_TOKEN} issued`,
    secret: FAKE_GITHUB_SERVER_TOKEN,
  },
  {
    category: "GitHub fine-grained PAT (github_pat_)",
    raw: `cloning with token ${FAKE_GITHUB_PAT}`,
    secret: FAKE_GITHUB_PAT,
  },
];

describe("redactValue — FR-17 redaction corpus (design §12)", () => {
  for (const { category, raw } of CORPUS) {
    it(`redacts a ${category} out of a plain message string`, () => {
      const result = redactValue(raw);
      expect(typeof result).toBe("string");
      for (const { secret } of CORPUS) {
        expect(result as string).not.toContain(secret);
      }
    });

    it(`redacts a ${category} out of a nested object field`, () => {
      const result = redactValue({
        message: "step output",
        details: { nested: { payload: raw } },
      }) as { details: { nested: { payload: string } } };
      expect(result.details.nested.payload).not.toContain(CORPUS.find((c) => c.category === category)?.secret);
    });
  }

  it("redacts the temporary access key id even bare inside the credential scope, not only via the whole-value param redaction", () => {
    const result = redactValue(`scope was ${FAKE_CREDENTIAL_SCOPE}`) as string;
    expect(result).not.toContain(FAKE_AWS_TEMP_ACCESS_KEY_ID);
  });

  it("keeps the presigned URL's non-secret parameters (X-Amz-Algorithm) visible", () => {
    const result = redactValue(`uploaded to ${FAKE_TEMP_CREDENTIALS_PRESIGNED_URL}`) as string;
    expect(result).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
  });

  it("redacts a password field by key even when the value carries no recognizable prefix", () => {
    const result = redactValue({ password: FAKE_PASSWORD_VALUE }) as { password: string };
    expect(result.password).not.toContain(FAKE_PASSWORD_VALUE);
  });

  it("redacts a secret field by key even when the value carries no recognizable prefix", () => {
    const result = redactValue({ secret: FAKE_SECRET_VALUE }) as { secret: string };
    expect(result.secret).not.toContain(FAKE_SECRET_VALUE);
  });

  it("leaves non-secret fields (executionId, stepId) untouched", () => {
    const result = redactValue({ executionId: "exec-123", stepId: "step-ssh-1", attempt: 2 }) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ executionId: "exec-123", stepId: "step-ssh-1", attempt: 2 });
  });

  describe("token/authorization key vocabulary (design §12 'tokens'), with correlation-id exemptions", () => {
    const FAKE_RAW_TOKEN = "fake-raw-token-value";

    it.each(["token", "accessToken", "sessionToken", "apiKey", "passphrase"])(
      "redacts a bare %s field by key alone (no recognizable value prefix)",
      (key) => {
        const result = redactValue({ [key]: FAKE_RAW_TOKEN }) as Record<string, unknown>;
        expect(result[key]).not.toBe(FAKE_RAW_TOKEN);
        expect(result[key]).toBe("[REDACTED]");
      },
    );

    it("redacts a nested Authorization field by key (e.g. { headers: { Authorization: 'Basic ...' } })", () => {
      const result = redactValue({ headers: { Authorization: `Basic ${FAKE_BASIC_AUTH_VALUE}` } }) as {
        headers: { Authorization: string };
      };
      expect(result.headers.Authorization).not.toContain(FAKE_BASIC_AUTH_VALUE);
    });

    it("does NOT redact dispatchToken — a correlation id FR-17's reconstruction scenario depends on surviving", () => {
      const result = redactValue({ dispatchToken: "dispatch-fake-123" }) as { dispatchToken: string };
      expect(result.dispatchToken).toBe("dispatch-fake-123");
    });

    it("does NOT redact fencingToken — a correlation id FR-17's reconstruction scenario depends on surviving", () => {
      const result = redactValue({ fencingToken: "fence-fake-7" }) as { fencingToken: string };
      expect(result.fencingToken).toBe("fence-fake-7");
    });

    it("does NOT redact idempotencyToken — design DD-04: idempotencyToken = dispatchToken, a correlation id, not a secret (reviewer round 2, bullet 3)", () => {
      const result = redactValue({ idempotencyToken: "dispatch-fake-123" }) as { idempotencyToken: string };
      expect(result.idempotencyToken).toBe("dispatch-fake-123");
    });

    it("does NOT redact nextToken — AWS pagination, not a secret (reviewer round 2 advisory)", () => {
      const result = redactValue({ nextToken: "page-fake-cursor-9" }) as { nextToken: string };
      expect(result.nextToken).toBe("page-fake-cursor-9");
    });

    it("does NOT mangle idempotencyToken when it appears as string content, not only as an object key", () => {
      const result = redactValue(`retrying with idempotencyToken=dispatch-fake-123`) as string;
      expect(result).toContain("idempotencyToken=dispatch-fake-123");
    });
  });

  describe("object walk generalization (reviewer round 1, bullet 3)", () => {
    it("normalizes an Error instance and redacts a secret in its message", () => {
      const error = new Error(`ssh connect failed: password=${FAKE_PASSWORD_VALUE}`);
      const result = redactValue(error) as { name: string; message: string; stack?: string };

      expect(result.message).not.toContain(FAKE_PASSWORD_VALUE);
      expect(result.name).toBe("Error");
    });

    it("normalizes an Error instance and redacts a secret in its stack", () => {
      const error = new Error("deploy failed");
      error.stack = `Error: deploy failed\n    at run (/app/deploy.js:10:5) token=${FAKE_BEARER_TOKEN}`;
      const result = redactValue(error) as { stack?: string };

      expect(result.stack).not.toContain(FAKE_BEARER_TOKEN);
    });

    it("redacts a secret carried on an Error instance's own enumerable property", () => {
      const error = new Error("auth failed") as Error & { password?: string };
      error.password = FAKE_PASSWORD_VALUE;
      const result = redactValue(error) as { password?: string };

      expect(result.password).not.toBe(FAKE_PASSWORD_VALUE);
      expect(result.password).toBe("[REDACTED]");
    });

    it("recurses into a null-prototype object instead of leaving it untouched", () => {
      const bare = Object.create(null) as Record<string, unknown>;
      bare.password = FAKE_PASSWORD_VALUE;
      bare.executionId = "exec-123";

      const result = redactValue(bare) as Record<string, unknown>;

      expect(result.password).not.toBe(FAKE_PASSWORD_VALUE);
      expect(result.executionId).toBe("exec-123");
    });

    it("redacts a sensitive key regardless of the value's type (a number, not a string)", () => {
      const result = redactValue({ password: 123456 }) as { password: unknown };
      expect(result.password).toBe("[REDACTED]");
      expect(result.password).not.toBe(123456);
    });

    it("redacts secrets inside a nested array of objects", () => {
      const result = redactValue([
        { stepId: "step-1", detail: `password=${FAKE_PASSWORD_VALUE}` },
        { stepId: "step-2", password: FAKE_SECRET_VALUE },
      ]) as Array<Record<string, unknown>>;

      expect(JSON.stringify(result)).not.toContain(FAKE_PASSWORD_VALUE);
      expect(JSON.stringify(result)).not.toContain(FAKE_SECRET_VALUE);
      expect(result[0]?.stepId).toBe("step-1");
      expect(result[1]?.stepId).toBe("step-2");
    });

    it("leaves a Date instance untouched (not recursed into as a plain object)", () => {
      const date = new Date("2026-10-05T12:00:00.000Z");
      const result = redactValue(date);
      expect(result).toBe(date);
    });
  });

  describe("cycle guard (reviewer round 2, bullet 2: a cyclic object must never crash the logger)", () => {
    it("does not throw on a self-referencing object (would otherwise be a RangeError: Maximum call stack size exceeded)", () => {
      const cyclic: Record<string, unknown> = { stepId: "step-1", password: FAKE_PASSWORD_VALUE };
      cyclic.self = cyclic;

      expect(() => redactValue(cyclic)).not.toThrow();
    });

    it("replaces the cyclic back-reference with the string '[Circular]' and still redacts the real secret", () => {
      const cyclic: Record<string, unknown> = { stepId: "step-1", password: FAKE_PASSWORD_VALUE };
      cyclic.self = cyclic;

      const result = redactValue(cyclic) as Record<string, unknown>;

      expect(result.self).toBe("[Circular]");
      expect(result.password).toBe("[REDACTED]");
      expect(result.stepId).toBe("step-1");
    });

    it("does not throw on a cyclic Error (error.cause === error, a realistic shape for an SDK/HTTP error object)", () => {
      const error = new Error("ssh connect failed") as Error & { cause?: unknown };
      error.cause = error;

      expect(() => redactValue(error)).not.toThrow();
      const result = redactValue(error) as { cause?: unknown };
      expect(result.cause).toBe("[Circular]");
    });

    it("still fully redacts the same object reached twice via two different (non-cyclic) branches", () => {
      const shared = { password: FAKE_PASSWORD_VALUE };
      const result = redactValue({ first: shared, second: shared }) as { first: { password: string }; second: { password: string } };

      expect(result.first.password).toBe("[REDACTED]");
      expect(result.second.password).toBe("[REDACTED]");
    });
  });

  describe("Error.cause / AggregateError.errors are recursed and redacted (reviewer round 2 advisory)", () => {
    it("redacts a secret carried on error.cause", () => {
      const cause = new Error(`auth failed: password=${FAKE_PASSWORD_VALUE}`);
      const error = new Error("ssh step failed", { cause });

      const result = redactValue(error) as { cause?: { message?: string } };

      expect(result.cause?.message).not.toContain(FAKE_PASSWORD_VALUE);
    });

    it("redacts secrets carried on each error inside an AggregateError's errors array", () => {
      const errors = [new Error(`token=${FAKE_BEARER_TOKEN}`), new Error(`secret=${FAKE_SECRET_VALUE}`)];
      const aggregate = new AggregateError(errors, "multiple failures");

      const result = redactValue(aggregate) as { errors?: Array<{ message?: string }> };

      expect(result.errors?.[0]?.message).not.toContain(FAKE_BEARER_TOKEN);
      expect(result.errors?.[1]?.message).not.toContain(FAKE_SECRET_VALUE);
    });
  });

  describe("ARN over-redaction fix (reviewer round 2 advisory): secretsmanager is a service name, not a secret key", () => {
    const FAKE_SECRET_NAME = "my-fake-secret-ABC123";
    const FAKE_ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${FAKE_SECRET_NAME}`;

    it("keeps the region and account id visible instead of redacting the whole ARN tail", () => {
      const result = redactValue(`resolved via ${FAKE_ARN}`) as string;

      expect(result).toContain("arn:aws:secretsmanager:us-east-1:123456789012:secret:");
    });

    it("still redacts the secret's own friendly name (publication policy: no revealing secret names)", () => {
      const result = redactValue(`resolved via ${FAKE_ARN}`) as string;

      expect(result).not.toContain(FAKE_SECRET_NAME);
    });
  });

  describe("SigV4 / SigV2 Signature= redaction (reviewer round 2 advisory)", () => {
    it("redacts the trailing Signature= inside a SigV4 Authorization: AWS4-HMAC-SHA256 header", () => {
      const raw =
        `Authorization: AWS4-HMAC-SHA256 Credential=${FAKE_AWS_TEMP_ACCESS_KEY_ID}/20261005/us-east-1/s3/aws4_request, ` +
        `SignedHeaders=host;x-amz-date, Signature=${FAKE_SIGV4_SIGNATURE}`;

      const result = redactValue(raw) as string;

      expect(result).not.toContain(FAKE_SIGV4_SIGNATURE);
      expect(result).not.toContain(FAKE_AWS_TEMP_ACCESS_KEY_ID);
      expect(result).toContain("SignedHeaders=host;x-amz-date");
    });

    it("redacts a bare SigV2 presigned URL's Signature= query param (no X-Amz- prefix)", () => {
      const raw = `uploaded to https://fake-bucket.s3.amazonaws.com/fake-key?AWSAccessKeyId=${FAKE_AWS_ACCESS_KEY_ID}&Expires=1234567890&Signature=${FAKE_SIGV2_SIGNATURE}`;

      const result = redactValue(raw) as string;

      expect(result).not.toContain(FAKE_SIGV2_SIGNATURE);
      expect(result).toContain("Expires=1234567890");
    });
  });

  describe("URL-embedded basic-auth credentials (reviewer round 2 advisory)", () => {
    it("redacts the password out of scheme://user:PASSWORD@host, keeping the scheme and user visible", () => {
      const raw = `fetching from https://fake-user:${FAKE_URL_PASSWORD}@host.example.com/path`;

      const result = redactValue(raw) as string;

      expect(result).not.toContain(FAKE_URL_PASSWORD);
      expect(result).toContain("https://fake-user:");
      expect(result).toContain("@host.example.com/path");
    });
  });
});
