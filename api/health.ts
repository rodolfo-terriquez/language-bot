import type { HttpRequest, HttpResponse } from "../lib/http.js";

export default function handler(
  req: HttpRequest,
  res: HttpResponse
): void {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: {
      hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
      hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      hasQstashToken: !!process.env.QSTASH_TOKEN,
    },
  });
}
