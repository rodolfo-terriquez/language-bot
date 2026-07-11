import type { HttpRequest, HttpResponse } from "../lib/http.js";

export default async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const baseUrl = process.env.BASE_URL;
  if (!token || !webhookSecret || !baseUrl) {
    console.error("Telegram webhook setup is missing required configuration");
    res.status(503).json({ error: "Webhook setup unavailable" });
    return;
  }

  const providedSecret = req.headers["x-setup-token"];
  if (!providedSecret || !constantTimeEqual(providedSecret, webhookSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/telegram`;
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ["message", "edited_message"],
        drop_pending_updates: false,
      }),
    });
    const data = (await response.json()) as { ok?: boolean; description?: string };
    if (!response.ok || !data.ok) {
      console.error("Telegram rejected webhook setup", data.description || response.status);
      res.status(502).json({ error: "Telegram rejected webhook setup" });
      return;
    }

    res.status(200).json({ ok: true, webhookUrl });
  } catch (error) {
    console.error("Webhook setup failed", error);
    res.status(502).json({ error: "Webhook setup failed" });
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
