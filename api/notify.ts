import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySignature, scheduleProactiveCheckIn } from "../lib/qstash.js";
import {
  getProactiveSchedule,
  updateProactiveScheduleAfterCheckIn,
  getConversationData,
  getLongTermMemory,
  getEmiMemory,
  getUserProfile,
  addToConversation,
  addMemoryFact,
  updateMemoryFact,
  deleteMemoryFact,
  addEmiMemoryFact,
  updateEmiMemoryFact,
  deleteEmiMemoryFact,
  filterCommandMessages,
} from "../lib/redis.js";
import { generateProactiveCheckIn, type ConversationContext } from "../lib/llm.js";
import { sendMessage } from "../lib/telegram.js";

// Notification payload type
interface NotificationPayload {
  chatId: number;
  type: "proactive_checkin" | string;
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

    if (payload.type === "proactive_checkin") {
      await handleProactiveCheckIn(payload.chatId);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Notify error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleProactiveCheckIn(chatId: number): Promise<void> {
  console.log(`[Notify] Processing proactive check-in for chat ${chatId}`);

  // Check if proactive messages are still enabled for this user
  const schedule = await getProactiveSchedule(chatId);
  if (!schedule || !schedule.enabled) {
    console.log(`[Notify] Proactive check-ins disabled for chat ${chatId}, skipping`);
    return;
  }

  // Load user context
  const [profile, conversationData, memory, emiMemory] = await Promise.all([
    getUserProfile(chatId),
    getConversationData(chatId),
    getLongTermMemory(chatId),
    getEmiMemory(),
  ]);

  if (!profile) {
    console.log(`[Notify] No profile found for chat ${chatId}, skipping check-in`);
    return;
  }

  // Build conversation context (filter out command messages)
  const context: ConversationContext = {
    messages: filterCommandMessages(conversationData.messages),
    summary: conversationData.summary,
    memory,
    emiMemory,
  };

  // Generate proactive message
  const result = await generateProactiveCheckIn(context, profile.japaneseLevel);

  // Process any memory tool calls
  for (const toolCall of result.memoryToolCalls) {
    try {
      switch (toolCall.name) {
        case "add_memory":
          if (toolCall.arguments.category && toolCall.arguments.content) {
            await addMemoryFact(
              chatId,
              toolCall.arguments.category as "personal" | "preference" | "learning" | "other",
              toolCall.arguments.content,
            );
          }
          break;
        case "update_memory":
          if (toolCall.arguments.fact_id && toolCall.arguments.content) {
            await updateMemoryFact(chatId, toolCall.arguments.fact_id, toolCall.arguments.content);
          }
          break;
        case "delete_memory":
          if (toolCall.arguments.fact_id) {
            await deleteMemoryFact(chatId, toolCall.arguments.fact_id);
          }
          break;
        case "add_emi_memory":
          if (toolCall.arguments.category && toolCall.arguments.content) {
            await addEmiMemoryFact(
              toolCall.arguments.category as
                | "backstory"
                | "preference"
                | "experience"
                | "relationship"
                | "other",
              toolCall.arguments.content,
            );
          }
          break;
        case "update_emi_memory":
          if (toolCall.arguments.fact_id && toolCall.arguments.content) {
            await updateEmiMemoryFact(toolCall.arguments.fact_id, toolCall.arguments.content);
          }
          break;
        case "delete_emi_memory":
          if (toolCall.arguments.fact_id) {
            await deleteEmiMemoryFact(toolCall.arguments.fact_id);
          }
          break;
      }
    } catch (err) {
      console.error(`[Notify] Failed to execute memory tool call:`, err);
    }
  }

  // Send the message
  await sendMessage(chatId, result.response);

  // Add to conversation history (as assistant message with no user message)
  // We'll use a special marker for proactive messages
  await addToConversation(chatId, "[Emi initiated conversation]", result.response);

  console.log(`[Notify] Sent proactive check-in to chat ${chatId}`);

  // Schedule the next check-in
  try {
    const nextCheckIn = await scheduleProactiveCheckIn({
      chatId,
      earliestHour: schedule.earliestHour,
      latestHour: schedule.latestHour,
      timezone: schedule.timezone,
    });

    await updateProactiveScheduleAfterCheckIn(
      chatId,
      nextCheckIn.messageId,
      nextCheckIn.scheduledFor,
    );

    console.log(
      `[Notify] Scheduled next check-in for chat ${chatId} at ${new Date(nextCheckIn.scheduledFor).toISOString()}`,
    );
  } catch (err) {
    console.error(`[Notify] Failed to schedule next check-in for chat ${chatId}:`, err);
  }
}
