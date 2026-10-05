// @akili-spec changes/cicd-executor-poc design §4.1
// Shared .gitignore matcher: an entry must appear as a WHOLE, trimmed,
// non-comment LINE — never a substring match (reviewer round-1 finding:
// `text.includes(entry)` would also "pass" on a comment merely MENTIONING
// the filename, or on an unrelated longer pattern that happens to contain
// it as a substring).
export function gitignoreHasExactEntry(gitignoreText, entry) {
  return gitignoreText.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    return trimmed === entry;
  });
}
