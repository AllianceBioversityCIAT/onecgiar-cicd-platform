// @akili-spec changes/cicd-executor-poc design §6.6, DD-12, DD-23; requirements FR-14
// NotificationProvider over the Slack Web API (`chat.postMessage`,
// `chat.update` for the thread root). HTTP goes through an injectable
// client (default: Node's global `fetch`), so tests never touch the network.
// The bot token is fetched through `SecretProvider.getSecret` at the point of
// use (DD-23: startup only checks existence), is held in a local variable for
// one call and is never logged, returned or placed in an error message.
import type { NotificationEvent, NotificationProvider } from "../../../ports/notification-provider.js";
import type { SecretProvider } from "../../../ports/secret-provider.js";

export interface SlackHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface SlackHttpClient {
  post(url: string, init: { headers: Record<string, string>; body: string }): Promise<SlackHttpResponse>;
}

export interface CreateSlackProviderDeps {
  readonly secrets: SecretProvider;
  /** Maps a logical channel reference to the Slack channel identifier. Registry-backed in wiring. */
  readonly resolveChannel: (channelRef: string) => string | Promise<string>;
  readonly http?: SlackHttpClient;
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://slack.com/api";

const fetchClient: SlackHttpClient = {
  async post(url, init) {
    const response = await fetch(url, { method: "POST", headers: init.headers, body: init.body });
    return { status: response.status, json: () => response.json() };
  },
};

interface SlackApiResult {
  readonly ok?: boolean;
  readonly ts?: string;
  readonly error?: string;
}

export function createSlackProvider(deps: CreateSlackProviderDeps): NotificationProvider {
  const http = deps.http ?? fetchClient;
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

  async function call(method: string, token: string, payload: Record<string, unknown>): Promise<SlackApiResult> {
    const response = await http.post(`${baseUrl}/${method}`, {
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Slack ${method} failed: HTTP ${response.status}`);
    }
    const result = (await response.json()) as SlackApiResult;
    if (result.ok !== true) {
      throw new Error(`Slack ${method} failed: ${typeof result.error === "string" ? result.error : "unknown_error"}`);
    }
    return result;
  }

  return {
    name: "slack",
    async notify(event: NotificationEvent): Promise<{ threadRef?: string }> {
      const channel = await deps.resolveChannel(event.channelRef);
      const token = await deps.secrets.getSecret(event.tokenRef);
      const posted = await call("chat.postMessage", token, {
        channel,
        text: event.message,
        ...(event.threadRef !== undefined ? { thread_ts: event.threadRef } : {}),
      });
      if (event.threadRef !== undefined && event.rootText !== undefined) {
        await call("chat.update", token, { channel, ts: event.threadRef, text: event.rootText });
      }
      const threadRef = event.threadRef ?? posted.ts;
      return threadRef !== undefined ? { threadRef } : {};
    },
  };
}
