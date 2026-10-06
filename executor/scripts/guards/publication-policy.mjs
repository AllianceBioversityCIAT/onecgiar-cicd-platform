// @akili-spec changes/cicd-executor-poc design §4.1, DD-23; requirements NFR-02
//
// Guard 4: no real internal identifier or secret may ever be committed.
// Scans every VERSIONED-OR-ABOUT-TO-BE-VERSIONED file — `git ls-files`
// (tracked), `git diff --cached --name-only` (staged), AND `git ls-files
// --others --exclude-standard` (untracked but NOT gitignored — reviewer
// round-1 advisory: a file an in-flight task has not committed yet is still
// about to be versioned, so it must not slip through) — for: a 12-digit AWS
// account id, an IPv4 address outside the obvious documentation/loopback/
// private ranges, a `*.amazonaws.com` hostname, a PEM private-key header,
// an AKIA/ASIA access-key id, a GitHub token, a Slack token/webhook, and an
// email address other than noreply@anthropic.com (the only one this repo's
// commit attribution uses).
//
// Values are reported MASKED (report.mjs's `mask` — at most 2 characters,
// never half the value), never in full.
//
// Allowlisting (two narrow, explicit, justified mechanisms — never a
// blanket test/ or file-type exclusion):
//
//   1. GLOBAL_LITERAL_ALLOWLIST: exact matched values known to be universal,
//      non-sensitive, WIDELY-PUBLISHED placeholders wherever they appear —
//      never a real customer's identifier:
//        - "123456789012": AWS's own documentation example account id
//          (AWS SDK/IAM/STS docs), reused as a fixture in this repo
//          (observability-redaction.test.ts's ARN fixture).
//        - "AKIAIOSFODNN7EXAMPLE": AWS's own documentation example access
//          key id (used verbatim across AWS SDK/CLI docs), found in
//          test/integration/run-integration-tests.mjs (T-08, in-flight;
//          not edited here).
//        - "s3.us-west-2.amazonaws.com": the hostname of AWS's own public,
//          officially-documented DynamoDB Local download bucket
//          (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html),
//          found in test/support/dynamodb-local.mjs (T-08, in-flight; not
//          edited here). Not account/host-specific — a public AWS tooling
//          endpoint, not a real internal host.
//
//   2. PATH_SCOPED_ALLOWLIST: a short list of {path, rules} entries. Each
//      entry exempts ONLY the named rule categories, and ONLY in the one
//      named file — never a directory, never "all rules". Every entry here
//      exists because the file is an intentional, already-reviewed
//      REDACTION-CORPUS or NEGATIVE-FIXTURE test (obviously-fake values by
//      repo convention) that this task is not authorized to edit
//      (executor/test/unit/observability-*.test.ts — leader note) or that
//      pre-dates this task and is out of its minimal-scope mandate
//      (targets-schema.contract.test.ts). `requireFakeMarker: true` adds a
//      SECOND, narrower condition (reviewer round-2 advisory): the
//      exemption only applies when the matched value itself contains
//      "fake" (case-insensitive) OR a `FAKE_*`-shaped identifier appears
//      within 2 lines of the match — i.e. the exemption is restricted to
//      literals whose binding/name carries the repo's own "obviously fake"
//      marker convention, not merely "this file is generally exempt".
//      `requireFakeMarker: false` (targets-schema.contract.test.ts only) is
//      the explicit exception: that fixture's PEM-shaped placeholder value
//      (an ellipsis-truncated, self-evidently-invalid base64 body) carries
//      NO FAKE_* marker — narrowing it to a FAKE marker is NOT FEASIBLE
//      without editing that file, which is out of this task's scope, so
//      the broader (but still path+rule scoped) exemption is kept for it.
//      (This comment deliberately does not quote that fixture's literal
//      PEM-header text, so this guard's OWN source never self-matches its
//      pem-private-key rule now that guard 4 also scans untracked files.)
const GLOBAL_LITERAL_ALLOWLIST = new Set([
  "123456789012",
  "AKIAIOSFODNN7EXAMPLE",
  "s3.us-west-2.amazonaws.com",
]);

const PATH_SCOPED_ALLOWLIST = [
  {
    path: "executor/test/unit/observability-redaction.test.ts",
    rules: ["aws-access-key-id", "amazonaws-hostname", "github-token", "pem-private-key"],
    requireFakeMarker: true,
    reason: "T-17 redaction corpus (FR-17) — obviously-fake FAKE_* fixtures; off limits to this task (leader note).",
  },
  {
    path: "executor/test/unit/observability-logger.test.ts",
    rules: ["aws-access-key-id", "amazonaws-hostname", "pem-private-key"],
    requireFakeMarker: true,
    reason: "T-17 logger test — same FAKE_* redaction fixtures; off limits to this task (leader note).",
  },
  {
    path: "executor/test/contract/targets-schema.contract.test.ts",
    rules: ["pem-private-key"],
    requireFakeMarker: false,
    reason:
      'Negative fixture proving the schema REJECTS an inline "privateKey" value ("MIIB..." ellipsis-truncated placeholder, not a real key, but carrying no FAKE_* marker) — narrowing to a FAKE marker is not feasible without editing this file, which is out of this task\'s minimal scope.',
  },
];

// RFC 1918 private ranges, loopback, link-local, and RFC 5737/TEST-NET
// documentation ranges — the only IPv4 shapes that can legitimately appear
// in versioned source (e.g. a local bind address in a comment or fixture).
// Any other IPv4-shaped literal is a potential real host and is flagged.
const ALLOWED_IPV4_PREFIXES = [
  /^10\./, // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918
  /^192\.168\./, // RFC 1918
  /^127\./, // loopback
  /^169\.254\./, // link-local
  /^0\.0\.0\.0$/,
  /^255\.255\.255\.255$/,
  /^192\.0\.2\./, // RFC 5737 TEST-NET-1
  /^198\.51\.100\./, // RFC 5737 TEST-NET-2
  /^203\.0\.113\./, // RFC 5737 TEST-NET-3
];

const RULES = [
  {
    rule: "aws-account-id",
    // Negative lookaround excludes digit runs embedded in a hyphen-delimited
    // token (e.g. a UUID-shaped test fixture like
    // "11111111-1111-4111-8111-111111111111", whose last dash-delimited
    // segment is coincidentally 12 digits long) — a real AWS account id is
    // never written adjacent to a hyphen on either side.
    pattern: /(?<![\d-])\d{12}(?![\d-])/g,
  },
  {
    rule: "ipv4-address",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    isAllowed: (value) => ALLOWED_IPV4_PREFIXES.some((re) => re.test(value)),
  },
  { rule: "amazonaws-hostname", pattern: /\b[a-z0-9][a-z0-9.-]*\.amazonaws\.com\b/gi },
  { rule: "pem-private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { rule: "github-token", pattern: /\bgh[ps]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  {
    rule: "slack-token-or-webhook",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b|https:\/\/hooks\.slack\.com\/services\/\S+/g,
  },
  {
    rule: "email-address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    isAllowed: (value) => value.toLowerCase() === "noreply@anthropic.com",
  },
];

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { mask } from "./lib/report.mjs";
import { gitignoreHasExactEntry } from "./lib/gitignore.mjs";

function gitLines(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

function gitScannableFiles(repoRoot) {
  const tracked = gitLines(repoRoot, ["ls-files"]);
  const staged = gitLines(repoRoot, ["diff", "--cached", "--name-only"]);
  const untrackedNotIgnored = gitLines(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  // `.github/workflows/` (the trusted reusable workflow, DD-29) is always walked
  // from disk too, so it is scanned even before it is added to git. May not exist.
  return [...new Set([...tracked, ...staged, ...untrackedNotIgnored, ...workflowFiles(repoRoot)])];
}

function workflowFiles(repoRoot) {
  const dir = path.join(repoRoot, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);
}

/** Loads the OPTIONAL gitignored local denylist (one literal per line), if present. Never committed. */
function loadLocalDenylist(repoRoot) {
  const localDenylistPath = path.join(repoRoot, "executor", ".local", "publication-denylist.txt");
  if (!existsSync(localDenylistPath)) return [];
  return readFileSync(localDenylistPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** True if the match is "obviously fake": the matched value itself says so, or a FAKE_* identifier sits within 2 lines. */
function hasNearbyFakeMarker(lines, lineIndex, matchedValue) {
  if (/fake/i.test(matchedValue)) return true;
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(lines.length - 1, lineIndex + 2);
  for (let i = start; i <= end; i += 1) {
    if (/\bFAKE[_A-Z0-9]*\b/.test(lines[i] ?? "")) return true;
  }
  return false;
}

export async function runPublicationPolicyGuard(repoRoot) {
  const violations = [];

  const rootGitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  if (!gitignoreHasExactEntry(rootGitignore, ".local/")) {
    violations.push({
      guard: "publication-policy",
      file: ".gitignore",
      message: "does not exclude .local/ as a whole line — the optional local publication denylist must stay local-only (design §4.1)",
    });
  }

  const localDenylist = loadLocalDenylist(repoRoot);
  const files = gitScannableFiles(repoRoot);
  const allowlistByPath = new Map(PATH_SCOPED_ALLOWLIST.map((entry) => [entry.path, entry]));

  for (const relFile of files) {
    const absFile = path.join(repoRoot, relFile);
    let text;
    try {
      text = readFileSync(absFile, "utf8");
    } catch {
      continue; // deleted-but-staged, binary, or unreadable: not a text-secret hit
    }
    const allowlistEntry = allowlistByPath.get(relFile.split(path.sep).join("/"));
    const exemptRules = allowlistEntry ? new Set(allowlistEntry.rules) : undefined;
    const lines = text.split(/\r?\n/);

    for (const { rule, pattern, isAllowed } of RULES) {
      const isPathRuleExempt = exemptRules?.has(rule) ?? false;
      lines.forEach((lineText, index) => {
        for (const match of lineText.matchAll(pattern)) {
          const value = match[0];
          if (GLOBAL_LITERAL_ALLOWLIST.has(value)) continue;
          if (isAllowed?.(value)) continue;
          if (isPathRuleExempt) {
            const requireFakeMarker = allowlistEntry?.requireFakeMarker ?? false;
            if (!requireFakeMarker || hasNearbyFakeMarker(lines, index, value)) continue;
          }
          violations.push({
            guard: "publication-policy",
            file: relFile,
            line: index + 1,
            message: `matches ${rule} (${mask(value)}) — real internal identifiers and secrets must never be committed (design §4.1, DD-23)`,
          });
        }
      });
    }

    for (const literal of localDenylist) {
      lines.forEach((lineText, index) => {
        if (lineText.includes(literal)) {
          violations.push({
            guard: "publication-policy",
            file: relFile,
            line: index + 1,
            message: `matches an entry in the local publication denylist (${mask(literal)}) — never commit real identifiers (design §4.1)`,
          });
        }
      });
    }
  }

  return violations;
}
