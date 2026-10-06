// @akili-spec changes/cicd-executor-poc design §7.5 (test support)
// Regression guard for the flaky N-13 suite: ssh2's own ed25519 key generator emits
// keys it cannot parse back (~1%), so the test keys are generated with node:crypto.
import { describe, expect, it } from "vitest";
import { utils } from "../../src/adapters/ssh-deployer/ssh2-module.js";
import { generateTestKeyPair } from "../support/ssh-test-server.js";

describe("generateTestKeyPair", () => {
  it("always yields keys ssh2 can parse, and a public line matching the private key (1000 keys)", () => {
    for (let i = 0; i < 1000; i += 1) {
      const pair = generateTestKeyPair();
      const priv = utils.parseKey(pair.privateKey);
      const pub = utils.parseKey(pair.publicKey);
      expect(priv instanceof Error).toBe(false);
      expect(pub instanceof Error).toBe(false);
      const privKey = Array.isArray(priv) ? priv[0]! : priv;
      const pubKey = Array.isArray(pub) ? pub[0]! : pub;
      expect(Buffer.compare((privKey as { getPublicSSH(): Buffer }).getPublicSSH(), (pubKey as { getPublicSSH(): Buffer }).getPublicSSH())).toBe(0);
    }
  });
});
