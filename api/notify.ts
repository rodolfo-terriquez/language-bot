import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySignature } from "../lib/qstash.js";

// Notification payload type (simplified)
interface NotificationPayload {
  chatId: number;
  type: string;
  data?: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Only accept POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Verify QStash signature
    const signature = req.headers["upstash-signature"] as string | undefined;
    const rawBody = JSON.stringify(req.body);

    if (signature) {
      const isValid = await verifySignature(signature, rawBody);
      if (!isValid) {
        console.error("Invalid QStash signature");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    const payload = req.body as NotificationPayload;

    console.log(`[Notify] Received ${payload.type} for chat ${payload.chatId}`);

    // Placeholder for future notification handling
    // Currently no scheduled notifications are used

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Notify error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
