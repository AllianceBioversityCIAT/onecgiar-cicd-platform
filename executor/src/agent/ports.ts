// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §10, §11, §12
// The agent's outside world, as ports: its FIFO command queue, the shared results queue, the log store (S3 in
// production) and the per-target script credentials (STS in production). Production adapters live in
// `agent/adapters`; the tests use in-memory and file-system implementations. Nothing here knows a target's application.

export interface ReceivedCommandMessage {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  /** SQS SenderId (`<roleId>:<session>`), set by SQS from the sender's credentials. */
  readonly senderId?: string;
}

export interface CommandSource {
  /** Long poll (up to 20 s); `signal` aborts it when the agent starts shutting down. */
  receive(maxMessages: number, signal?: AbortSignal): Promise<readonly ReceivedCommandMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  /** Keeps a command invisible while it waits for a local slot (AC-04 §10.6); 0 hands it back to the queue now. */
  extendVisibility(receiptHandle: string, seconds: number): Promise<void>;
}

export interface EventSink {
  /** One AGENT_EVENT or AGENT_HEARTBEAT to the shared FIFO results queue. Throws when it could not be sent. */
  send(message: { readonly body: Readonly<Record<string, unknown>>; readonly groupId: string; readonly deduplicationId: string }): Promise<void>;
}

export interface LogStore {
  /** Private, encrypted object; throws on failure (the caller retries from its journal). */
  put(object: { readonly bucket: string; readonly key: string; readonly body: Uint8Array; readonly contentType: string; readonly contentEncoding?: string }): Promise<void>;
}

export interface ScriptCredentials {
  /** Temporary credentials of the target's script role, for ONE run (session name = execution id). */
  forScript(roleArn: string, sessionName: string): Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken: string }>;
}

export interface AgentLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
