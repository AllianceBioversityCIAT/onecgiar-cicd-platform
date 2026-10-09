// @akili-spec changes/cicd-executor-poc architecture-change-03 G-D7 (§4); design §6.5
// Requested vs verified version (AC-03). "Request processed", "script
// succeeded" and "version verified" are different facts: this module only
// decides the third one, from what the script reported in CICD_RESULT, for a
// run that already exited 0. It never changes the execution state.
//   MISMATCH      a reported commit differs from the requested one, or the
//                 request carried artifacts, the script reported deployed
//                 references and a requested digest is in none of them;
//   VERIFIED      no mismatch, and the reported commit equals the requested one
//                 or every requested digest appears in the reported references;
//   NOT_REPORTED  nothing comparable was reported.
// `versionGuaranteed` is false when the target runs its script with no
// arguments (`scriptArguments: none`): the script was never told the version.

export type VersionCheck = "VERIFIED" | "MISMATCH" | "NOT_REPORTED";

export interface VersionCheckInput {
  readonly commitSha: string;
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly targetSnapshot: { readonly scriptArguments?: "standard" | "none" };
}

export interface ReportedVersion {
  readonly status?: string;
  readonly deployedImages?: Readonly<Record<string, string>>;
  readonly deployedCommit?: string;
}

/** A deployed reference matches a digest when it is the digest itself or `<location>@<digest>`. */
function referencesDigest(reference: string, digest: string): boolean {
  return reference === digest || reference.endsWith(`@${digest}`);
}

export function versionCheckOf(
  item: VersionCheckInput,
  reported: ReportedVersion | undefined,
): { readonly versionCheck: VersionCheck; readonly versionGuaranteed: boolean } {
  const versionGuaranteed = (item.targetSnapshot.scriptArguments ?? "standard") !== "none";
  const requestedDigests = Object.values(item.artifacts ?? {});
  const deployedReferences = reported?.deployedImages === undefined ? undefined : Object.values(reported.deployedImages);

  const commitReported = reported?.deployedCommit !== undefined;
  const commitMatches = commitReported && reported?.deployedCommit === item.commitSha;
  const digestsComparable = requestedDigests.length > 0 && deployedReferences !== undefined;
  const digestsMatch =
    digestsComparable && requestedDigests.every((digest) => (deployedReferences as string[]).some((ref) => referencesDigest(ref, digest)));

  let versionCheck: VersionCheck;
  if ((commitReported && !commitMatches) || (digestsComparable && !digestsMatch)) versionCheck = "MISMATCH";
  else if (commitMatches || digestsMatch) versionCheck = "VERIFIED";
  else versionCheck = "NOT_REPORTED";
  return { versionCheck, versionGuaranteed };
}
