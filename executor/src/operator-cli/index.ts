// @akili-spec changes/cicd-executor-poc design §4.2 (tools/), §6.4, §7.7, DD-21, runbook §12.2; requirements FR-18, FR-24; tasks R-5 (AC-02 V1: events name the targetId)
// Operator CLI core: turns arguments into schema-valid internal events
// (DEPLOY_WINDOW_OPEN_REQUESTED, DEPLOY_WINDOW_CLOSE_REQUESTED,
// TARGET_RESOLUTION_RECORDED) and hands them to a QueuePublisher port. It
// only emits events: it never edits state, never decides ordering and never
// trusts itself — the Executor re-validates everything when it processes the
// event (coverage, bounds, resolution preconditions). Authorizing the operator
// principal is the sender-authorizer's job (DD-25, N-06).
import { randomUUID } from "node:crypto";
import type { Clock } from "../ports/clock.js";
import type { QueuePublisher } from "../ports/queue-publisher.js";

export interface CliDeps {
  readonly publisher: QueuePublisher;
  readonly clock: Clock;
  readonly newEventId?: () => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const USAGE = [
  "Usage:",
  "  tools/deploy-window open  --target-id <targetId> --opened-by <who> --disabled <id>[,<id>…] (--closes-at <ISO-8601> | --hours <n>) [--note <text>] [--dry-run]",
  "  tools/deploy-window close --target-id <targetId> --closed-by <who> [--note <text>] [--dry-run]",
  "  tools/resolve-target --target-id <targetId> --execution-id <id> --resolved-by <who> --observed <unit>=<sha256:digest> [--observed …] [--note <text>] [--dry-run]",
].join("\n");

interface ParsedArgs {
  readonly flags: Map<string, string[]>;
  readonly bare: readonly string[];
}

const BOOLEAN_FLAGS = new Set(["dry-run"]);

function parseArgs(argv: readonly string[]): ParsedArgs | { readonly error: string } {
  const flags = new Map<string, string[]>();
  const bare: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      bare.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, ["true"]);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `Missing value for --${name}` };
    flags.set(name, [...(flags.get(name) ?? []), value]);
    i += 1;
  }
  return { flags, bare };
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

type BuildResult = { readonly event: Record<string, unknown> } | { readonly error: string };

function single(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function envelope(deps: CliDeps, eventType: string): Record<string, unknown> {
  return {
    specVersion: 1,
    eventId: (deps.newEventId ?? randomUUID)(),
    eventType,
    timestamp: deps.clock.now().toISOString(),
    source: "operator",
  };
}

function missing(args: ParsedArgs, names: readonly string[]): string | undefined {
  const absent = names.filter((name) => single(args, name) === undefined || single(args, name) === "");
  return absent.length === 0 ? undefined : `Missing required option(s): ${absent.map((n) => `--${n}`).join(", ")}`;
}

function withNote(event: Record<string, unknown>, args: ParsedArgs): Record<string, unknown> {
  const note = single(args, "note");
  return note === undefined ? event : { ...event, note };
}

function buildOpen(args: ParsedArgs, deps: CliDeps): BuildResult {
  const absent = missing(args, ["target-id", "opened-by"]);
  if (absent !== undefined) return { error: absent };
  const disabled = (args.flags.get("disabled") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  if (disabled.length === 0) return { error: "At least one --disabled external job identifier is required" };

  let closesAt: string;
  const explicit = single(args, "closes-at");
  const hours = single(args, "hours");
  if (explicit !== undefined && hours !== undefined) return { error: "Use either --closes-at or --hours, not both" };
  if (explicit !== undefined) {
    const parsed = Date.parse(explicit);
    if (Number.isNaN(parsed)) return { error: "--closes-at must be an ISO-8601 date-time" };
    closesAt = new Date(parsed).toISOString();
  } else if (hours !== undefined) {
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) return { error: "--hours must be a positive number" };
    closesAt = new Date(deps.clock.now().getTime() + n * 3_600_000).toISOString();
  } else {
    return { error: "Either --closes-at or --hours is required" };
  }
  return {
    event: withNote(
      {
        ...envelope(deps, "DEPLOY_WINDOW_OPEN_REQUESTED"),
        targetId: single(args, "target-id"),
        openedBy: single(args, "opened-by"),
        externalJobsDisabled: disabled,
        closesAt,
      },
      args,
    ),
  };
}

function buildClose(args: ParsedArgs, deps: CliDeps): BuildResult {
  const absent = missing(args, ["target-id", "closed-by"]);
  if (absent !== undefined) return { error: absent };
  return {
    event: withNote(
      {
        ...envelope(deps, "DEPLOY_WINDOW_CLOSE_REQUESTED"),
        targetId: single(args, "target-id"),
        closedBy: single(args, "closed-by"),
      },
      args,
    ),
  };
}

function buildResolve(args: ParsedArgs, deps: CliDeps): BuildResult {
  const absent = missing(args, ["target-id", "execution-id", "resolved-by"]);
  if (absent !== undefined) return { error: absent };
  const observed = args.flags.get("observed") ?? [];
  if (observed.length === 0) return { error: "At least one --observed <unit>=<digest> is required" };
  const digests: Record<string, string> = {};
  for (const pair of observed) {
    const eq = pair.indexOf("=");
    const unit = eq > 0 ? pair.slice(0, eq) : "";
    const digest = eq > 0 ? pair.slice(eq + 1) : "";
    if (unit === "" || !SHA256_DIGEST.test(digest)) {
      return { error: `--observed must be <unit>=sha256:<64 hex>, got "${pair}"` };
    }
    if (Object.hasOwn(digests, unit)) return { error: `Duplicate --observed unit "${unit}"` };
    digests[unit] = digest;
  }
  return {
    event: withNote(
      {
        ...envelope(deps, "TARGET_RESOLUTION_RECORDED"),
        targetId: single(args, "target-id"),
        executionId: single(args, "execution-id"),
        resolvedBy: single(args, "resolved-by"),
        observedDigests: digests,
      },
      args,
    ),
  };
}

/**
 * Runs the CLI. `argv` excludes the node and script paths. Returns the process
 * exit code (0 ok, 2 usage/validation error, 1 publish failure).
 */
export async function runOperatorCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  if ("error" in parsed) {
    deps.err(parsed.error);
    deps.err(USAGE);
    return 2;
  }

  let built: BuildResult;
  if (command === "open") built = buildOpen(parsed, deps);
  else if (command === "close") built = buildClose(parsed, deps);
  else if (command === "resolve-target") built = buildResolve(parsed, deps);
  else {
    deps.err(`Unknown command: ${command ?? "(none)"}`);
    deps.err(USAGE);
    return 2;
  }
  if ("error" in built) {
    deps.err(built.error);
    return 2;
  }

  if (single(parsed, "dry-run") === "true") {
    deps.out(JSON.stringify(built.event));
    return 0;
  }
  try {
    const { messageId } = await deps.publisher.publish({ body: built.event });
    deps.out(`Published ${String(built.event["eventType"])} (eventId ${String(built.event["eventId"])}, messageId ${messageId})`);
    return 0;
  } catch (error) {
    deps.err(`Publish failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
