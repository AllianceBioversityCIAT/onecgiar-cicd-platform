// @akili-spec changes/cicd-executor-poc design §6.5, FR-13
// Parses the script's `CICD_RESULT` line. Only the LAST non-empty stdout line
// counts; it must be `CICD_RESULT <json>` with exactly the documented shape.
// A malformed result is treated as missing as a whole: never trusted partially.
import type { CicdResult } from "../../ports/deploy-transport.js";

const PREFIX = "CICD_RESULT ";
const MIGRATIONS = new Set(["APPLIED", "NONE", "FAILED"]);

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

export function parseCicdResultLine(line: string): CicdResult | undefined {
  if (!line.startsWith(PREFIX)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.status !== "string") return undefined;
  if (o.deployedImages !== undefined && !isStringRecord(o.deployedImages)) return undefined;
  if (o.previousImages !== undefined && !isStringRecord(o.previousImages)) return undefined;
  if (o.migrations !== undefined && (typeof o.migrations !== "string" || !MIGRATIONS.has(o.migrations))) return undefined;
  if (o.healthy !== undefined && typeof o.healthy !== "boolean") return undefined;
  if (o.mutexHolder !== undefined && typeof o.mutexHolder !== "string") return undefined;
  if (o.deployedCommit !== undefined && (typeof o.deployedCommit !== "string" || !/^[0-9a-f]{40}$/.test(o.deployedCommit))) return undefined;
  return {
    status: o.status,
    ...(o.deployedImages === undefined ? {} : { deployedImages: o.deployedImages as Record<string, string> }),
    ...(o.previousImages === undefined ? {} : { previousImages: o.previousImages as Record<string, string> }),
    ...(o.migrations === undefined ? {} : { migrations: o.migrations as "APPLIED" | "NONE" | "FAILED" }),
    ...(o.healthy === undefined ? {} : { healthy: o.healthy }),
    ...(o.mutexHolder === undefined ? {} : { mutexHolder: o.mutexHolder }),
    ...(o.deployedCommit === undefined ? {} : { deployedCommit: o.deployedCommit as string }),
  };
}

/**
 * `stdout` is the (possibly front-truncated) stdout. When `truncated`, the
 * first line may be a fragment, so a result that would have to be that first
 * fragment is treated as missing.
 */
export function parseCicdResult(stdout: string, truncated = false): CicdResult | undefined {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0) return undefined;
  if (truncated && lines.length === 1) return undefined;
  return parseCicdResultLine(lines[lines.length - 1]!);
}
