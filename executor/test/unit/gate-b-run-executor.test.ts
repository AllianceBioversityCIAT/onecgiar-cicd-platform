// @akili-spec changes/cicd-executor-poc gate-b-plan K-6
// The owner-run launcher scripts, exercised with a FAKE node. The real Executor is never started.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(here, "..", "..", "..", "tools", "gate-b");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "run-executor-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const bashOk = (() => {
  const r = spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
  return r.error === undefined && r.status === 0 && r.stdout.trim() !== "";
})();

/** POSIX form of a path (C:\x -> /c/x when running Git Bash on Windows). */
function posix(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
}

// A syntactically valid, obviously fake role ARN (the Executor role the isolated profile must assume).
// Built at runtime so the 12-digit placeholder account never appears literally (publication guard).
const fakeRoleArn = (name: string) => `arn:aws:iam::${"0".repeat(12)}:role/${name}`;
const TEST_ROLE_ARN = fakeRoleArn("cicd-test-executor");
// Valid isolated files: the target profiles used by the tests carry role_arn + source_profile only.
const GOOD_AWS_CONFIG = [
  "[profile <EXECUTOR_PROFILE_NAME>]",
  `role_arn = ${TEST_ROLE_ARN}`,
  "source_profile = cicd-executor-source",
  "[profile <P>]",
  `role_arn = ${TEST_ROLE_ARN}`,
  "source_profile = cicd-executor-source",
  "[profile cicd-executor-source]",
  "region = us-east-1",
  "",
].join("\n");
const GOOD_AWS_CREDS = "[cicd-executor-source]\naws_access_key_id = FAKE\naws_secret_access_key = FAKE\n";
/** Whether this machine lets the tests create a symbolic link / junction (no privilege on some Windows setups). */
function canLink(type: "file" | "junction"): boolean {
  const base = mkdtempSync(path.join(tmpRoot, "linkprobe-"));
  try {
    const target = path.join(base, "target");
    if (type === "file") writeFileSync(target, "x");
    else mkdirSync(target);
    symlinkSync(target, path.join(base, "link"), type);
    return true;
  } catch {
    return false;
  }
}
const symlinkOk = canLink("file");
const junctionOk = canLink("junction");
let counter = 0;
interface Fixture {
  dir: string;
  execDir: string;
  node: string;
  envFile: string;
  record: string;
  envDump: string;
  marker: string;
  awsConfig: string;
  awsCreds: string;
  fakeHome: string;
}
function fixture(opts: { version: string; env: string | Buffer; withDist?: boolean; waitForSignal?: boolean; shell?: "sh" | "ps"; awsConfigText?: string; awsCredsText?: string }): Fixture {
  const dir = path.join(tmpRoot, `f${counter++}`);
  const execDir = path.join(dir, "executor");
  mkdirSync(execDir, { recursive: true });
  if (opts.withDist !== false) {
    mkdirSync(path.join(execDir, "dist", "src", "main"), { recursive: true });
    writeFileSync(path.join(execDir, "dist", "src", "main", "index.js"), "// fake\n");
  }
  const record = path.join(dir, "node-calls.txt");
  const envDump = path.join(dir, "node-env.txt");
  const marker = path.join(dir, "term-marker.txt");
  const node = path.join(dir, "fake-node.sh");
  // Fake node: --version prints the version; otherwise records args, dumps only CICD_*/AWS_* env keys and, when asked, waits for SIGTERM.
  const wait = opts.waitForSignal
    ? `trap 'echo TERM > "${posix(marker)}"; exit 0' TERM\necho ready > "${posix(path.join(dir, "ready.txt"))}"\nsleep 30 >/dev/null 2>&1 &\nwait $!\n`
    : "";
  writeFileSync(
    node,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo ${opts.version}; exit 0; fi\necho "$@" >> "${posix(record)}"\nenv | grep -E '^(CICD_|AWS_)' | sort > "${posix(envDump)}"\n${wait}exit 0\n`,
  );
  chmodSync(node, 0o755);
  // Isolated AWS files (SR-3) and a fake home that holds the DEFAULT ~/.aws files.
  const awsDir = path.join(execDir, ".local", "aws");
  mkdirSync(awsDir, { recursive: true });
  const awsConfig = path.join(awsDir, "config");
  const awsCreds = path.join(awsDir, "credentials");
  writeFileSync(awsConfig, opts.awsConfigText ?? GOOD_AWS_CONFIG);
  writeFileSync(awsCreds, opts.awsCredsText ?? GOOD_AWS_CREDS);
  const fakeHome = path.join(dir, "home");
  mkdirSync(path.join(fakeHome, ".aws"), { recursive: true });
  writeFileSync(path.join(fakeHome, ".aws", "config"), "[default]\n");
  writeFileSync(path.join(fakeHome, ".aws", "credentials"), "[default]\n");
  const fmt = opts.shell === "ps" ? (p: string) => p : posix;
  const envFile = path.join(dir, "executor.env");
  const env = (typeof opts.env === "string" ? opts.env : opts.env.toString("utf8")).replaceAll("{{AWS_CONFIG}}", fmt(awsConfig)).replaceAll("{{AWS_CREDS}}", fmt(awsCreds));
  writeFileSync(envFile, env);
  return { dir, execDir, node, envFile, record, envDump, marker, awsConfig, awsCreds, fakeHome };
}

function runSh(f: Fixture, extra: string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    [
      posix(path.join(toolsDir, "run-executor.sh")),
      "--env-file", posix(f.envFile),
      "--node", posix(f.node),
      "--executor-dir", posix(f.execDir),
      ...extra,
    ],
    { encoding: "utf8", timeout: 60_000, ...(env === undefined ? {} : { env }) },
  );
}

const AWS_FILES = `AWS_CONFIG_FILE={{AWS_CONFIG}}
AWS_SHARED_CREDENTIALS_FILE={{AWS_CREDS}}
CICD_EXECUTOR_ROLE_ARN=${TEST_ROLE_ARN}`;
const GOOD_ENV = [
  "# comment",
  "",
  "AWS_PROFILE=<EXECUTOR_PROFILE_NAME>",
  AWS_FILES,
  "AWS_REGION=<AWS_REGION>",
  'CICD_TABLE_NAME="<EXECUTIONS_TABLE_NAME>"',
  "CICD_QUEUE_URL=https://fake.invalid/secret-looking-queue",
].join("\n");

interface Adapter {
  make(env: string, extra?: { awsConfigText?: string; awsCredsText?: string }): Fixture;
  run(f: Fixture, args?: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  fmt(p: string): string;
}
const withKey = (env: string, key: string, value: string) =>
  `${env.split("\n").filter((l) => !l.startsWith(`${key}=`)).join("\n")}\n${key}=${value}\n`;
const ALT_CRED_VARS = [
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
];

/** Hardened SR-3 rules, shared by both launchers (allow-list, links, config content, env scrub). */
function hardeningRules(a: Adapter): void {
  const refused = (f: Fixture, r: SpawnSyncReturns<string>, ...needles: string[]) => {
    expect(r.status).toBe(2);
    for (const n of needles) expect(r.stderr).toContain(n);
    expect(existsSync(f.record)).toBe(false);
  };
  const point = (f: Fixture, key: string, target: string) =>
    writeFileSync(f.envFile, withKey(readFileSync(f.envFile, "utf8"), key, a.fmt(target)));
  const KEYS = ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"];

  it.each(KEYS)("refuses a relative path in %s", (key) => {
    const f = a.make(withKey(GOOD_ENV, key, ".local/aws/config"));
    refused(f, a.run(f), key, "absolute path");
  });

  it.each(KEYS)("refuses a valid file outside <executor-dir>/.local/aws in %s (allow-list)", (key) => {
    const f = a.make(GOOD_ENV);
    const outside = path.join(f.dir, "elsewhere", "file");
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, key === "AWS_CONFIG_FILE" ? GOOD_AWS_CONFIG : GOOD_AWS_CREDS);
    point(f, key, outside);
    refused(f, a.run(f), key, "outside");
  });

  it.each(KEYS)("refuses a file with more than one hard link in %s", (key) => {
    const f = a.make(GOOD_ENV);
    const original = key === "AWS_CONFIG_FILE" ? f.awsConfig : f.awsCreds;
    const link = path.join(path.dirname(original), "second-name");
    linkSync(original, link);
    point(f, key, link);
    refused(f, a.run(f), key, "hard link");
  });

  it.skipIf(!junctionOk)("refuses when .local/aws is a junction or directory link to another directory", () => {
    const f = a.make(GOOD_ENV);
    const awsDir = path.dirname(f.awsConfig);
    const moved = path.join(f.dir, "moved-aws");
    renameSync(awsDir, moved);
    symlinkSync(moved, awsDir, "junction");
    refused(f, a.run(f), "link");
  });

  it.skipIf(!symlinkOk)("refuses a symbolic link to a valid file (skipped when symlinks cannot be created)", () => {
    const f = a.make(GOOD_ENV);
    const real = path.join(f.dir, "real-config");
    writeFileSync(real, GOOD_AWS_CONFIG);
    const link = path.join(path.dirname(f.awsConfig), "config-link");
    symlinkSync(real, link, "file");
    point(f, "AWS_CONFIG_FILE", link);
    refused(f, a.run(f), "link");
  });

  it.each(["AWS_PROFILE", "AWS_CONFIG_FILE", "CICD_TABLE_NAME"])("refuses a duplicate env key (%s) instead of letting the last value win", (key) => {
    const f = a.make(`${GOOD_ENV}\n${key}=\n`);
    refused(f, a.run(f), `duplicate key ${key}`);
  });

  it.skipIf(!junctionOk)("refuses when .local is a link and the env file names the PHYSICAL target path (logical path rule)", () => {
    const f = a.make(GOOD_ENV);
    const localDir = path.dirname(path.dirname(f.awsConfig));
    const moved = path.join(f.dir, "moved-local");
    renameSync(localDir, moved);
    symlinkSync(moved, localDir, "junction");
    point(f, "AWS_CONFIG_FILE", path.join(moved, "aws", "config"));
    point(f, "AWS_SHARED_CREDENTIALS_FILE", path.join(moved, "aws", "credentials"));
    refused(f, a.run(f), "outside");
  });

  it.skipIf(!junctionOk)("refuses when .local is a link and the env file names the logical path through it", () => {
    const f = a.make(GOOD_ENV);
    const localDir = path.dirname(path.dirname(f.awsConfig));
    const moved = path.join(f.dir, "moved-local");
    renameSync(localDir, moved);
    symlinkSync(moved, localDir, "junction");
    refused(f, a.run(f), "link");
  });

  const SENTINEL = "SENTINEL-VALUE";

  it.each(["credential_process", "credential_source", "role_arn", "source_profile", "aws_session_token", "web_identity_token_file", "sso_start_url"])(
    "refuses a credentials file that contains the key %s",
    (k) => {
      const f = a.make(GOOD_ENV, { awsCredsText: `${GOOD_AWS_CREDS}${k} = ${SENTINEL}\n` });
      const r = a.run(f);
      refused(f, r, `'${k}'`);
      expect(r.stderr).not.toContain(SENTINEL);
    },
  );

  it("refuses a profile whose role_arn is not exactly CICD_EXECUTOR_ROLE_ARN, without echoing either value", () => {
    const other = fakeRoleArn("cicd-test-other-admin");
    const f = a.make(GOOD_ENV, { awsConfigText: GOOD_AWS_CONFIG.replaceAll(TEST_ROLE_ARN, other) });
    const r = a.run(f);
    refused(f, r, "not exactly CICD_EXECUTOR_ROLE_ARN");
    expect(r.stderr).not.toContain("other-admin");
    expect(r.stderr).not.toContain("cicd-test-executor");
  });

  it.each(["absent", "empty"])("refuses a CICD_EXECUTOR_ROLE_ARN that is %s", (kind) => {
    const env = kind === "empty"
      ? withKey(GOOD_ENV, "CICD_EXECUTOR_ROLE_ARN", "")
      : GOOD_ENV.split("\n").filter((l) => !l.startsWith("CICD_EXECUTOR_ROLE_ARN=")).join("\n");
    const f = a.make(env);
    refused(f, a.run(f), "CICD_EXECUTOR_ROLE_ARN");
  });

  it.each(["not-an-arn", "arn:aws:iam::123:role/short-account", fakeRoleArn("x").replace(":role/", ":user/"), fakeRoleArn("")])(
    "refuses a malformed CICD_EXECUTOR_ROLE_ARN (%s)",
    (bad) => {
      const f = a.make(withKey(GOOD_ENV, "CICD_EXECUTOR_ROLE_ARN", bad));
      const r = a.run(f);
      refused(f, r, "CICD_EXECUTOR_ROLE_ARN");
      expect(r.stderr).not.toContain(bad);
    },
  );

  it("passes a valid setup and keeps CICD_EXECUTOR_ROLE_ARN away from the child", () => {
    const f = a.make(GOOD_ENV);
    const r = a.run(f);
    expect(r.status).toBe(0);
    const lines = readFileSync(f.envDump, "utf8").split(/\r?\n/);
    expect(lines.some((l) => l.startsWith("CICD_EXECUTOR_ROLE_ARN="))).toBe(false);
    expect(lines).toContain("AWS_PROFILE=<EXECUTOR_PROFILE_NAME>");
  });
  const profile = (extra: string) => `[profile <EXECUTOR_PROFILE_NAME>]\nrole_arn = ${TEST_ROLE_ARN}\nsource_profile = src\n${extra}`;
  it.each<[string, string, string]>([
    ["has no profile section for AWS_PROFILE", `[profile other]\nrole_arn = x\nsource_profile = y\n`, "no [profile <EXECUTOR_PROFILE_NAME>]"],
    ["has no role_arn", `[profile <EXECUTOR_PROFILE_NAME>]\nsource_profile = y\n`, "no role_arn"],
    ["has no source_profile", `[profile <EXECUTOR_PROFILE_NAME>]\nrole_arn = x\n`, "no source_profile"],
    ["contains credential_process", profile(`[profile other]\ncredential_process = ${SENTINEL}\n`), "credential_process"],
    ["contains credential_source", profile(`credential_source = ${SENTINEL}\n`), "credential_source"],
    ["contains web_identity_token_file", profile(`web_identity_token_file = ${SENTINEL}\n`), "web_identity_token_file"],
    ["contains an sso_ key", profile(`[profile other]\nsso_start_url = ${SENTINEL}\n`), "sso_start_url"],
    ["contains an sso-session section", profile(`[sso-session s]\n`), "sso-session"],
  ])("refuses an isolated config that %s", (_title, text, needle) => {
    const f = a.make(GOOD_ENV, { awsConfigText: text });
    refused(f, a.run(f), needle);
    expect(a.run(f).stderr).not.toContain(SENTINEL);
  });

  it.each(["[<EXECUTOR_PROFILE_NAME>]", "[profile <EXECUTOR_PROFILE_NAME>]"])("refuses a credentials file with a section named like AWS_PROFILE (%s)", (header) => {
    const f = a.make(GOOD_ENV, { awsCredsText: `${header}\naws_access_key_id = FAKE\naws_secret_access_key = FAKE\n` });
    refused(f, a.run(f), "section named like AWS_PROFILE");
  });

  it("removes alternative credential sources from the child, warns, and sets AWS_EC2_METADATA_DISABLED=true", () => {
    const f = a.make(`${GOOD_ENV}\nAWS_ROLE_ARN=<FROM_ENV_FILE>\nAWS_EC2_METADATA_DISABLED=false\n`);
    const inherited = Object.fromEntries(ALT_CRED_VARS.map((k) => [k, "fake"]));
    const r = a.run(f, [], { ...process.env, ...inherited });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("inherited AWS_WEB_IDENTITY_TOKEN_FILE is ignored");
    const lines = readFileSync(f.envDump, "utf8").split(/\r?\n/);
    for (const k of ALT_CRED_VARS) expect(lines.some((l) => l.startsWith(`${k}=`))).toBe(false);
    expect(lines).toContain("AWS_EC2_METADATA_DISABLED=true");
  });
}

describe.skipIf(!bashOk)("run-executor.sh", { timeout: 30_000 }, () => {
  describe("hardened isolated AWS files (SR-3)", () => {
    hardeningRules({
      make: (env, extra) => fixture({ version: "v22.11.0", env, ...extra }),
      run: (f, args = [], env) => runSh(f, args, env),
      fmt: posix,
    });
  });

  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", posix(path.join(toolsDir, "run-executor.sh"))], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("dry run prints the command and redacted env, and never starts the main script", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
    const r = runSh(f, ["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("v22.11.0");
    expect(r.stdout).toContain("command:");
    expect(r.stdout).toContain("dist/src/main/index.js");
    expect(r.stdout).toContain("AWS_REGION=<set>");
    expect(r.stdout).toContain("CICD_TABLE_NAME=<set>");
    expect(r.stdout).not.toContain("secret-looking-queue");
    expect(r.stdout).not.toContain("<EXECUTIONS_TABLE_NAME>");
    expect(existsSync(f.record)).toBe(false);
  });

  it("refuses Node 20 with exit 2", () => {
    const f = fixture({ version: "v20.19.5", env: GOOD_ENV });
    const r = runSh(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Node major 22 is required");
    expect(existsSync(f.record)).toBe(false);
  });

  it.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])("refuses a static key (%s) in the env file", (key) => {
    const f = fixture({ version: "v22.11.0", env: `${GOOD_ENV}\n${key}=fake\n` });
    const r = runSh(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(key);
    expect(existsSync(f.record)).toBe(false);
  });

  it("refuses CICD_DYNAMODB_ENDPOINT unless explicitly allowed", () => {
    const f = fixture({ version: "v22.11.0", env: `${GOOD_ENV}\nCICD_DYNAMODB_ENDPOINT=http://localhost:8000\n` });
    const refused = runSh(f);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CICD_DYNAMODB_ENDPOINT");
    const allowed = runSh(f, ["--allow-local-endpoint", "--dry-run"]);
    expect(allowed.status).toBe(0);
  });

  it("refuses when dist/src/main/index.js is missing", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV, withDist: false });
    const r = runSh(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("npm ci && npm run build");
  });

  it("runs the main script through the selected node and delivers the env to the child", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
    const r = runSh(f);
    expect(r.status).toBe(0);
    expect(readFileSync(f.record, "utf8").trim()).toBe("dist/src/main/index.js");
    const dump = readFileSync(f.envDump, "utf8");
    expect(dump).toContain("AWS_PROFILE=<EXECUTOR_PROFILE_NAME>");
    expect(dump).toContain("CICD_TABLE_NAME=<EXECUTIONS_TABLE_NAME>");
  });

  it("passes values literally: command substitution, backticks and '=' inside a value, with CRLF line endings", () => {
    const env = ["AWS_PROFILE=<P>", AWS_FILES,"CICD_A=$(echo x)", "CICD_B=`echo y`", "CICD_C=a=b=c", "CICD_D='quoted value'"].join("\r\n") + "\r\n";
    const f = fixture({ version: "v22.11.0", env });
    const r = runSh(f);
    expect(r.status).toBe(0);
    const dump = readFileSync(f.envDump, "utf8").split("\n");
    expect(dump).toContain("CICD_A=$(echo x)");
    expect(dump).toContain("CICD_B=`echo y`");
    expect(dump).toContain("CICD_C=a=b=c");
    expect(dump).toContain("CICD_D=quoted value");
    expect(dump).toContain("AWS_PROFILE=<P>");
  });

  it("strips a leading UTF-8 BOM from the first env line", () => {
    const f = fixture({ version: "v22.11.0", env: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`AWS_PROFILE=<P>\nCICD_A=1\n${AWS_FILES}\n`)]) });
    const r = runSh(f);
    expect(r.status).toBe(0);
    expect(readFileSync(f.envDump, "utf8")).toContain("AWS_PROFILE=<P>");
  });

  it("refuses when AWS_PROFILE is missing or empty", () => {
    for (const env of [`CICD_A=1\n${AWS_FILES}\n`, `AWS_PROFILE=\nCICD_A=1\n${AWS_FILES}\n`]) {
      const f = fixture({ version: "v22.11.0", env });
      const r = runSh(f);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("AWS_PROFILE");
      expect(existsSync(f.record)).toBe(false);
    }
  });

  it("removes inherited static AWS keys from the child env and warns", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
    const r = runSh(f, [], { ...process.env, AWS_ACCESS_KEY_ID: "fake-id", AWS_SECRET_ACCESS_KEY: "fake-secret", AWS_SESSION_TOKEN: "fake-token" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("inherited AWS_ACCESS_KEY_ID is ignored");
    const dump = readFileSync(f.envDump, "utf8");
    expect(dump).not.toContain("AWS_ACCESS_KEY_ID");
    expect(dump).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(dump).not.toContain("AWS_SESSION_TOKEN");
  });

  describe("isolated AWS files (SR-3)", () => {
    const withoutLine = (env: string, key: string) =>
      env.split("\n").filter((l) => !l.startsWith(`${key}=`)).join("\n");

    it.each(["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"])("refuses when %s is missing", (key) => {
      const f = fixture({ version: "v22.11.0", env: withoutLine(GOOD_ENV, key) });
      const r = runSh(f);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(key);
      expect(existsSync(f.record)).toBe(false);
    });

    it.each(["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"])("refuses when %s points to a file that does not exist", (key) => {
      const f = fixture({ version: "v22.11.0", env: `${withoutLine(GOOD_ENV, key)}\n${key}=${posix(path.join(tmpRoot, "nope"))}\n` });
      const r = runSh(f);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("does not exist");
      expect(existsSync(f.record)).toBe(false);
    });

    it.each([
      ["AWS_CONFIG_FILE", "config"],
      ["AWS_SHARED_CREDENTIALS_FILE", "credentials"],
    ])("refuses when %s points to the default ~/.aws file", (key, name) => {
      const f = fixture({ version: "v22.11.0", env: withoutLine(GOOD_ENV, key) });
      // Point the key at the DEFAULT file of the fake home (the env file gets the key appended after the isolated one is dropped).
      writeFileSync(f.envFile, `${readFileSync(f.envFile, "utf8")}\n${key}=${posix(path.join(f.fakeHome, ".aws", name))}\n`);
      const r = runSh(f, [], { ...process.env, HOME: posix(f.fakeHome), USERPROFILE: f.fakeHome });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`default ~/.aws/${name}`);
      expect(existsSync(f.record)).toBe(false);
    });

    it("delivers the isolated files and the profile to the child and shows them as <set> in the dry run", () => {
      const f = fixture({ version: "v22.11.0", env: GOOD_ENV });
      const env = { ...process.env, HOME: posix(f.fakeHome), USERPROFILE: f.fakeHome };
      const dry = runSh(f, ["--dry-run"], env);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("AWS_CONFIG_FILE=<set>");
      expect(dry.stdout).toContain("AWS_SHARED_CREDENTIALS_FILE=<set>");
      const r = runSh(f, [], env);
      expect(r.status).toBe(0);
      const dump = readFileSync(f.envDump, "utf8");
      expect(dump).toContain(`AWS_CONFIG_FILE=${posix(f.awsConfig)}`);
      expect(dump).toContain(`AWS_SHARED_CREDENTIALS_FILE=${posix(f.awsCreds)}`);
      expect(dump).toContain("AWS_PROFILE=<EXECUTOR_PROFILE_NAME>");
    });
  });

  it.each(["--env-file", "--node", "--executor-dir"])("fails fast with exit 2 when %s has no value", (opt) => {
    const r = spawnSync("bash", [posix(path.join(toolsDir, "run-executor.sh")), opt], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a value");
  });

  it("forwards SIGTERM sent to the launcher to node (no orphan, ordered shutdown)", () => {
    const f = fixture({ version: "v22.11.0", env: GOOD_ENV, waitForSignal: true });
    const ready = path.join(f.dir, "ready.txt");
    // One bash drives the launcher in the background, waits for node to be ready, sends SIGTERM to the launcher PID.
    const driver = [
      'bash "$1" --env-file "$2" --node "$3" --executor-dir "$4" &',
      "pid=$!",
      'for i in $(seq 1 100); do [ -f "$5" ] && break; sleep 0.1; done',
      '[ -f "$5" ] || { kill -KILL $pid 2>/dev/null; echo "node never became ready" >&2; exit 3; }',
      "kill -TERM $pid",
      "wait $pid",
    ].join("\n");
    const r = spawnSync(
      "bash",
      ["-c", driver, "driver", posix(path.join(toolsDir, "run-executor.sh")), posix(f.envFile), posix(f.node), posix(f.execDir), posix(ready)],
      { encoding: "utf8", timeout: 40_000 },
    );
    expect(r.stderr).not.toContain("never became ready");
    expect(existsSync(f.marker)).toBe(true);
  });
});

const psAvailable = process.platform === "win32" && spawnSync("powershell", ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe.skipIf(!psAvailable)("run-executor.ps1", { timeout: 30_000 }, () => {
  const ps1 = path.join(toolsDir, "run-executor.ps1");

  it("parses with zero errors", () => {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1}',[ref]$t,[ref]$e);if($e.Count -gt 0){$e|ForEach-Object{$_.Message};exit 1}`,
      ],
      { encoding: "utf8" },
    );
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  // A `.cmd` shim stands in for node.exe (a real Node is not available in tests).
  function psFixture(version: string, env: string, withDist = true, extra: { awsConfigText?: string; awsCredsText?: string } = {}) {
    const f = fixture({ version, env, withDist, shell: "ps", ...extra });
    const cmd = path.join(f.dir, "fake-node.cmd");
    writeFileSync(cmd, `@echo off\r\nif "%1"=="--version" (echo ${version}& exit /b 0)\r\necho %* >> "${f.record}"\r\nset > "${f.envDump}"\r\nexit /b 0\r\n`);
    return { ...f, node: cmd };
  }
  function runPs(f: { node: string; envFile: string; execDir: string }, extra: string[] = [], env?: NodeJS.ProcessEnv) {
    return spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-EnvFile", f.envFile, "-NodePath", f.node, "-ExecutorDir", f.execDir, ...extra],
      { encoding: "utf8", timeout: 60_000, ...(env === undefined ? {} : { env }) },
    );
  }

  it("dry run prints the redacted env and starts nothing", () => {
    const f = psFixture("v22.11.0", GOOD_ENV);
    const r = runPs(f, ["-DryRun"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AWS_REGION=<set>");
    expect(r.stdout).not.toContain("secret-looking-queue");
    expect(existsSync(f.record)).toBe(false);
  });

  it("refuses Node 20 with exit 2", () => {
    const f = psFixture("v20.19.5", GOOD_ENV);
    const r = runPs(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Node major 22 is required");
  });

  it("refuses a static key (naming it) and a local endpoint", () => {
    const key = runPs(psFixture("v22.11.0", `${GOOD_ENV}\nAWS_SECRET_ACCESS_KEY=fake\n`));
    expect(key.status).toBe(2);
    expect(key.stderr).toContain("AWS_SECRET_ACCESS_KEY");
    expect(runPs(psFixture("v22.11.0", `${GOOD_ENV}\nCICD_DYNAMODB_ENDPOINT=http://localhost:8000\n`)).status).toBe(2);
  });

  it("refuses when dist is missing", () => {
    expect(runPs(psFixture("v22.11.0", GOOD_ENV, false)).status).toBe(2);
  });

  it("refuses when AWS_PROFILE is missing", () => {
    const r = runPs(psFixture("v22.11.0", `CICD_A=1\n${AWS_FILES}\n`));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("AWS_PROFILE");
  });

  describe("hardened isolated AWS files (SR-3)", () => {
    hardeningRules({
      make: (env, extra) => psFixture("v22.11.0", env, true, extra),
      run: (f, args = [], env) => runPs(f as unknown as { node: string; envFile: string; execDir: string }, args, env),
      fmt: (p) => p,
    });
  });

  describe("isolated AWS files (SR-3)", () => {
    const withoutLine = (env: string, key: string) => env.split("\n").filter((l) => !l.startsWith(`${key}=`)).join("\n");

    it.each(["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"])("refuses when %s is missing", (key) => {
      const f = psFixture("v22.11.0", withoutLine(GOOD_ENV, key));
      const r = runPs(f);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(key);
      expect(existsSync(f.record)).toBe(false);
    });

    it.each(["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"])("refuses when %s points to a file that does not exist", (key) => {
      const f = psFixture("v22.11.0", `${withoutLine(GOOD_ENV, key)}\n${key}=${path.join(tmpRoot, "nope")}\n`);
      const r = runPs(f);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("does not exist");
      expect(existsSync(f.record)).toBe(false);
    });

    it.each([
      ["AWS_CONFIG_FILE", "config"],
      ["AWS_SHARED_CREDENTIALS_FILE", "credentials"],
    ])("refuses when %s points to the default %USERPROFILE%\\.aws file", (key, name) => {
      const f = psFixture("v22.11.0", withoutLine(GOOD_ENV, key));
      writeFileSync(f.envFile, `${readFileSync(f.envFile, "utf8")}\n${key}=${path.join(f.fakeHome, ".aws", name)}\n`);
      const r = runPs(f, [], { ...process.env, USERPROFILE: f.fakeHome });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`.aws\\${name}`);
      expect(existsSync(f.record)).toBe(false);
    });

    it("delivers the isolated files and the profile to the child and shows them as <set> in the dry run", () => {
      const f = psFixture("v22.11.0", GOOD_ENV);
      writeFileSync(f.node, `@echo off\r\nif "%1"=="--version" (echo v22.11.0& exit /b 0)\r\nset > "${f.envDump}"\r\nexit /b 0\r\n`);
      const env = { ...process.env, USERPROFILE: f.fakeHome };
      const dry = runPs(f, ["-DryRun"], env);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("AWS_CONFIG_FILE=<set>");
      expect(dry.stdout).toContain("AWS_SHARED_CREDENTIALS_FILE=<set>");
      const r = runPs(f, [], env);
      expect(r.status).toBe(0);
      const dump = readFileSync(f.envDump, "utf8");
      expect(dump).toContain(`AWS_CONFIG_FILE=${f.awsConfig}`);
      expect(dump).toContain(`AWS_SHARED_CREDENTIALS_FILE=${f.awsCreds}`);
      expect(dump).toContain("AWS_PROFILE=<EXECUTOR_PROFILE_NAME>");
    });
  });

  it("removes inherited static keys from the child env, warns, and passes values literally", () => {
    const f = psFixture("v22.11.0", `${GOOD_ENV}\nCICD_A=$(echo x)\nCICD_C=a=b\n`);
    // The .cmd shim dumps the whole environment.
    writeFileSync(f.node, `@echo off\r\nif "%1"=="--version" (echo v22.11.0& exit /b 0)\r\nset > "${f.envDump}"\r\nexit /b 0\r\n`);
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-EnvFile", f.envFile, "-NodePath", f.node, "-ExecutorDir", f.execDir],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, AWS_ACCESS_KEY_ID: "fake-id" } },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("inherited AWS_ACCESS_KEY_ID is ignored");
    const dump = readFileSync(f.envDump, "utf8");
    expect(dump).not.toContain("AWS_ACCESS_KEY_ID");
    expect(dump).toContain("CICD_A=$(echo x)");
    expect(dump).toContain("CICD_C=a=b");
  });
});
