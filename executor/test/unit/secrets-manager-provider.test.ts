// @akili-spec changes/cicd-executor-poc design §4.2, §7, NFR-02, DD-16, DD-23
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { SecretProviderError, SecretsManagerSecretProvider, type SecretsManagerSender } from "../../src/adapters/secrets-manager-provider/index.js";

const PREFIX = "cicd-poc/dev/";
const SAMPLE_ARN = "arn:aws:secretsmanager:<AWS_REGION>:<AWS_ACCOUNT_ID>:secret:x";

type Handler = (command: unknown) => unknown;
function fakeClient(handler: Handler): SecretsManagerSender & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command);
      return handler(command);
    },
  };
}
function awsError(name: string): Error {
  const e = new Error(`User is not authorized to access ${SAMPLE_ARN}`);
  e.name = name;
  return e;
}
function everything(e: unknown): string {
  const err = e as Error;
  return [err.message, err.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e)), String(Object.getOwnPropertyDescriptor(e, "cause")?.value)].join("\n");
}
async function capture(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

describe("SecretsManagerSecretProvider", () => {
  it("maps a logical ref to prefix + name", async () => {
    const client = fakeClient(() => ({}));
    await new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).exists("<SLACK_TOKEN_REF>");
    const cmd = client.calls[0] as DescribeSecretCommand;
    expect(cmd.input.SecretId).toBe("cicd-poc/dev/SLACK_TOKEN_REF");
  });

  it("rejects a non-logical ref without calling the SDK", async () => {
    const client = fakeClient(() => ({}));
    const p = new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX });
    for (const bad of ["SLACK", "<lower>", "<A B>", "", "<A>/../x"]) {
      await expect(p.exists(bad)).rejects.toBeInstanceOf(SecretProviderError);
      await expect(p.getSecret(bad)).rejects.toBeInstanceOf(SecretProviderError);
    }
    expect(client.calls).toHaveLength(0);
  });

  // A target record's credentialRef is a full secret name under the Executor's prefix (design §6.3,
  // target-record.schema.json: no '<' or '>'), enforced at onboarding (R-7) and again here (fail closed).
  it("reads a target credentialRef (full secret name under the prefix) as-is, for getSecret and exists", async () => {
    const client = fakeClient(() => ({ SecretString: "key" }));
    const p = new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX });
    expect(await p.getSecret("cicd-poc/dev/example-app-dev/ssh")).toBe("key");
    await p.exists("cicd-poc/dev/example-app-dev/ssh");
    expect((client.calls[0] as GetSecretValueCommand).input.SecretId).toBe("cicd-poc/dev/example-app-dev/ssh");
    expect((client.calls[1] as DescribeSecretCommand).input.SecretId).toBe("cicd-poc/dev/example-app-dev/ssh");
  });

  it("refuses a full secret name outside the prefix, the bare prefix, a look-alike prefix or an ARN, without calling the SDK", async () => {
    const client = fakeClient(() => ({ SecretString: "key" }));
    const p = new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX });
    for (const bad of ["other/app/ssh", "cicd-poc/dev/", "cicd-poc/devx/ssh", "cicd-poc/dev-other/ssh", SAMPLE_ARN, "cicd-poc/dev/a b"]) {
      const error = (await capture(p.getSecret(bad))) as SecretProviderError;
      expect(error).toBeInstanceOf(SecretProviderError);
      expect(error.code).toBe("InvalidLogicalRef");
      await expect(p.exists(bad)).rejects.toBeInstanceOf(SecretProviderError);
    }
    expect(client.calls).toHaveLength(0);
  });

  it("refuses every full secret name when the prefix is empty (nothing to scope it to)", async () => {
    const client = fakeClient(() => ({ SecretString: "key" }));
    await expect(new SecretsManagerSecretProvider({ client, secretIdPrefix: "" }).getSecret("example-app-dev/ssh")).rejects.toBeInstanceOf(SecretProviderError);
    expect(client.calls).toHaveLength(0);
  });

  it("exists uses DescribeSecret only, never GetSecretValue", async () => {
    const client = fakeClient(() => ({ Name: "n" }));
    expect(await new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).exists("<A_REF>")).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toBeInstanceOf(DescribeSecretCommand);
    expect(client.calls.some((c) => c instanceof GetSecretValueCommand)).toBe(false);
  });

  it("exists is false when the secret is not found", async () => {
    const client = fakeClient(() => {
      throw awsError("ResourceNotFoundException");
    });
    expect(await new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).exists("<A_REF>")).toBe(false);
  });

  it("exists is false when the secret is scheduled for deletion", async () => {
    const client = fakeClient(() => ({ DeletedDate: new Date() }));
    expect(await new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).exists("<A_REF>")).toBe(false);
  });

  it("exists on access denied throws a sanitized error with ref and code only", async () => {
    const client = fakeClient(() => {
      throw awsError("AccessDeniedException");
    });
    const e = await capture(new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).exists("<A_REF>"));
    expect(e).toBeInstanceOf(SecretProviderError);
    const text = everything(e);
    expect(text).toContain("<A_REF>");
    expect(text).toContain("AccessDeniedException");
    expect(text).not.toContain("arn:aws");
    expect(text).not.toContain("AWS_ACCOUNT_ID");
    expect(text).not.toContain("cicd-poc/dev");
    expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("getSecret returns SecretString unchanged, including a trailing newline", async () => {
    const client = fakeClient(() => ({ SecretString: " fake-value\n" }));
    const v = await new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).getSecret("<A_REF>");
    expect(v).toBe(" fake-value\n");
    expect(client.calls[0]).toBeInstanceOf(GetSecretValueCommand);
    expect((client.calls[0] as GetSecretValueCommand).input.SecretId).toBe("cicd-poc/dev/A_REF");
  });

  it("getSecret does not cache", async () => {
    const client = fakeClient(() => ({ SecretString: "v" }));
    const p = new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX });
    await p.getSecret("<A_REF>");
    await p.getSecret("<A_REF>");
    expect(client.calls).toHaveLength(2);
  });

  it("getSecret with only SecretBinary fails sanitized, without leaking the value", async () => {
    const client = fakeClient(() => ({ SecretBinary: new Uint8Array([115, 101, 99]) }));
    const e = await capture(new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).getSecret("<A_REF>"));
    expect(e).toBeInstanceOf(SecretProviderError);
    expect(everything(e)).toContain("<A_REF>");
    expect(everything(e)).not.toContain("115");
  });

  it("getSecret not found and access denied are sanitized and name the logical ref", async () => {
    for (const name of ["ResourceNotFoundException", "AccessDeniedException"]) {
      const client = fakeClient(() => {
        throw awsError(name);
      });
      const e = await capture(new SecretsManagerSecretProvider({ client, secretIdPrefix: PREFIX }).getSecret("<A_REF>"));
      const text = everything(e);
      expect(text).toContain("<A_REF>");
      expect(text).toContain(name);
      expect(text).not.toContain("arn:aws");
      expect(text).not.toContain("cicd-poc/dev");
    }
  });

  it("rejects an invalid prefix at construction", () => {
    const client = fakeClient(() => ({}));
    for (const bad of ["a b/", "x*", "a\n"]) {
      expect(() => new SecretsManagerSecretProvider({ client, secretIdPrefix: bad })).toThrow(/invalid secret id prefix/);
    }
    expect(() => new SecretsManagerSecretProvider({ client, secretIdPrefix: "" })).not.toThrow();
  });
});
