// @akili-spec changes/cicd-executor-poc design §6.6, DD-23; requirements FR-14
// Slack provider over an injected HTTP client (no network).
import { describe, expect, it } from "vitest";
import { createSlackProvider, type SlackHttpClient } from "../../src/adapters/notify/slack-provider/index.js";
import { FakeSecretProvider } from "../support/fake-secret-provider.js";

const FAKE_TOKEN = ["xo", "xb-FAKE-0000000000-fake-token-value"].join(""); // built at runtime so no token-shaped literal is committed

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function http(responses: Array<{ status: number; json: unknown } | Error>) {
  const calls: Call[] = [];
  const client: SlackHttpClient = {
    async post(url, init) {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return { status: next.status, json: async () => next.json };
    },
  };
  return { client, calls };
}

const secrets = new FakeSecretProvider({ "<SLACK_TOKEN>": FAKE_TOKEN });
const resolveChannel = (ref: string) => (ref === "<DEPLOY_CHANNEL>" ? "C0FAKE001" : "C0FAKE002");
const event = { kind: "ACCEPTED", message: "hello", channelRef: "<DEPLOY_CHANNEL>", tokenRef: "<SLACK_TOKEN>" };

describe("slack provider", () => {
  it("posts via chat.postMessage with the resolved channel, token in the header only, and returns ts", async () => {
    const { client, calls } = http([{ status: 200, json: { ok: true, ts: "17.1" } }]);
    const result = await createSlackProvider({ secrets, resolveChannel, http: client }).notify(event);

    expect(result).toEqual({ threadRef: "17.1" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(calls[0]!.body).toEqual({ channel: "C0FAKE001", text: "hello" });
    expect(JSON.stringify(calls[0]!.body)).not.toContain(FAKE_TOKEN);
  });

  it("replies with thread_ts and updates the root when rootText is given", async () => {
    const { client, calls } = http([
      { status: 200, json: { ok: true, ts: "17.2" } },
      { status: 200, json: { ok: true } },
    ]);
    const result = await createSlackProvider({ secrets, resolveChannel, http: client }).notify({
      ...event,
      threadRef: "17.1",
      rootText: "done",
    });
    expect(result).toEqual({ threadRef: "17.1" });
    expect(calls[0]!.body).toMatchObject({ thread_ts: "17.1" });
    expect(calls[1]!.url).toBe("https://slack.com/api/chat.update");
    expect(calls[1]!.body).toEqual({ channel: "C0FAKE001", ts: "17.1", text: "done" });
  });

  it("HTTP 500 rejects without the token in the error", async () => {
    const { client } = http([{ status: 500, json: {} }]);
    const error = await createSlackProvider({ secrets, resolveChannel, http: client })
      .notify(event)
      .catch((e: Error) => e);
    expect((error as Error).message).toBe("Slack chat.postMessage failed: HTTP 500");
  });

  it("ok:false rejects with the Slack error code", async () => {
    const { client } = http([{ status: 200, json: { ok: false, error: "channel_not_found" } }]);
    await expect(createSlackProvider({ secrets, resolveChannel, http: client }).notify(event)).rejects.toThrow(
      "channel_not_found",
    );
  });

  it("network error propagates to the caller (the service absorbs it)", async () => {
    const { client } = http([new Error("ECONNRESET")]);
    await expect(createSlackProvider({ secrets, resolveChannel, http: client }).notify(event)).rejects.toThrow("ECONNRESET");
  });

  it("reads the token at point of use via getSecret on every call", async () => {
    const reads: string[] = [];
    const spy = {
      getSecret: async (ref: string) => {
        reads.push(ref);
        return FAKE_TOKEN;
      },
      exists: async () => true,
    };
    const { client } = http([
      { status: 200, json: { ok: true, ts: "1" } },
      { status: 200, json: { ok: true, ts: "2" } },
    ]);
    const provider = createSlackProvider({ secrets: spy, resolveChannel, http: client });
    await provider.notify(event);
    await provider.notify(event);
    expect(reads).toEqual(["<SLACK_TOKEN>", "<SLACK_TOKEN>"]);
  });
});
