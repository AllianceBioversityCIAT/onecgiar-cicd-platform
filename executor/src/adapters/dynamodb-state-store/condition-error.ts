// @akili-spec changes/cicd-executor-poc design DD-03
// Shared helper: every repository's conditional write must turn a rejected
// DynamoDB condition into a quiet "no-op", never an exception — DD-03:
// "condition failure = already processed = no-op with ack".
export function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Runs a conditional write, mapping a rejected condition to `false` and
 * letting every other error (network, throttling, validation) propagate —
 * DD-03 only promises idempotency for the condition-failure case, not for
 * infrastructure errors, which callers must still see and handle.
 */
export async function runConditionalWrite(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      return false;
    }
    throw error;
  }
}
