// @akili-spec changes/cicd-executor-poc design §7 (execution-service, handlers/source)
// Port: resolves a branch to an exact commit and fetches that commit's
// source tree. No project-specific logic (NFR-01): generic repository URL,
// branch and commit identifiers only.

export interface GitClient {
  resolveCommit(repositoryUrl: string, branch: string): Promise<string>;
  fetchCommit(
    repositoryUrl: string,
    commit: string,
    destinationPath: string,
  ): Promise<void>;
}
