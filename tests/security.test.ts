import { afterEach, describe, expect, test } from "bun:test";
import notifyHandler from "../api/notify.js";
import setupHandler from "../api/setup.js";
import telegramHandler from "../api/telegram.js";
import { verifySignature } from "../lib/qstash.js";
import type { HttpRequest, HttpResponse } from "../lib/http.js";

class Capture implements HttpResponse {
  code = 200;
  value: unknown;

  status(code: number): HttpResponse {
    this.code = code;
    return this;
  }

  json(body: unknown): void {
    this.value = body;
  }

  send(body: string): void {
    this.value = body;
  }
}

const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("public endpoint authentication", () => {
  test("Telegram rejects requests without the webhook secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "expected-secret";
    const response = new Capture();
    await telegramHandler(request({ body: {} }), response);
    expect(response.code).toBe(401);
  });

  test("QStash callback rejects requests without a signature", async () => {
    const response = new Capture();
    await notifyHandler(request({ body: { chatId: 1, type: "proactive_checkin" }, rawBody: "{}" }), response);
    expect(response.code).toBe(401);
  });

  test("webhook setup is POST-only and authenticated", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "expected-secret";
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.BASE_URL = "https://example.com";

    const getResponse = new Capture();
    await setupHandler(request({ method: "GET" }), getResponse);
    expect(getResponse.code).toBe(405);

    const postResponse = new Capture();
    await setupHandler(request(), postResponse);
    expect(postResponse.code).toBe(401);
  });

  test("QStash verification fails closed without signing keys", async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    expect(await verifySignature("signature", "{}" )).toBe(false);
  });
});

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "POST",
    body: undefined,
    query: {},
    headers: {},
    ...overrides,
  };
}
