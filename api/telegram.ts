import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import {
  parseIntent,
  generateConversationResponse,
  generateConversationSummary,
  translateToEnglish,
  ConversationContext,
  MemoryToolCall,
} from "../lib/llm.js";
import * as redis from "../lib/redis.js";
import { scheduleProactiveCheckIn, cancelScheduledMessage } from "../lib/qstash.js";

// Execute memory tool calls from the LLM response
async function executeMemoryToolCalls(chatId: number, toolCalls: MemoryToolCall[]): Promise<void> {
  for (const call of toolCalls) {
    try {
      switch (call.name) {
        // User memory tools
        case "add_memory":
          if (call.arguments.category && call.arguments.content) {
            await redis.addMemoryFact(
              chatId,
              call.arguments.category as "personal" | "preference" | "learning" | "other",
              call.arguments.content,
            );
            console.log(`[${chatId}] Added user memory: ${call.arguments.content}`);
          }
          break;
        case "update_memory":
          if (call.arguments.fact_id && call.arguments.content) {
            await redis.updateMemoryFact(chatId, call.arguments.fact_id, call.arguments.content);
            console.log(`[${chatId}] Updated user memory: ${call.arguments.fact_id}`);
          }
          break;
        case "delete_memory":
          if (call.arguments.fact_id) {
            await redis.deleteMemoryFact(chatId, call.arguments.fact_id);
            console.log(`[${chatId}] Deleted user memory: ${call.arguments.fact_id}`);
          }
          break;
        // Emi's self-memory tools
        case "add_emi_memory":
          if (call.arguments.category && call.arguments.content) {
            await redis.addEmiMemoryFact(
              call.arguments.category as
                | "backstory"
                | "preference"
                | "experience"
                | "relationship"
                | "other",
              call.arguments.content,
            );
            console.log(`[${chatId}] Added Emi memory: ${call.arguments.content}`);
          }
          break;
        case "update_emi_memory":
          if (call.arguments.fact_id && call.arguments.content) {
            await redis.updateEmiMemoryFact(call.arguments.fact_id, call.arguments.content);
            console.log(`[${chatId}] Updated Emi memory: ${call.arguments.fact_id}`);
          }
          break;
        case "delete_emi_memory":
          if (call.arguments.fact_id) {
            await redis.deleteEmiMemoryFact(call.arguments.fact_id);
            console.log(`[${chatId}] Deleted Emi memory: ${call.arguments.fact_id}`);
          }
          break;
      }
    } catch (e) {
      console.error(`[${chatId}] Failed to execute memory tool call:`, e);
    }
  }
}

// Register the summarization callback to avoid circular imports
redis.setSummarizationCallback(generateConversationSummary);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let chatId: number | undefined;

  try {
    const update = req.body as TelegramUpdate;

    if (!update.message) {
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = update;
    chatId = message.chat.id;

    // Idempotency: avoid processing the same Telegram message twice
    try {
      const processed = await redis.tryMarkMessageProcessed(chatId, message.message_id, 180);
      if (!processed) {
        console.log(`[${chatId}] Duplicate webhook message_id ${message.message_id} ignored`);
        res.status(200).json({ ok: true });
        return;
      }
    } catch (e) {
      console.warn(
        `[${chatId}] Could not set idempotency key for message ${message.message_id}:`,
        e,
      );
    }

    // Check if user is allowed
    const allowedUsers = process.env.ALLOWED_USERS;
    if (allowedUsers) {
      const allowed = allowedUsers.split(",").map((u) => u.trim().toLowerCase());
      const userId = message.from?.id?.toString();
      const username = message.from?.username?.toLowerCase();

      if (!(userId && allowed.includes(userId)) && !(username && allowed.includes(username))) {
        await telegram.sendMessage(chatId, "Sorry, this bot is private.");
        res.status(200).json({ ok: true });
        return;
      }
    }

    // New user setup
    const isNewUser = await redis.registerChat(chatId);
    if (isNewUser) {
      const displayName = message.from?.first_name || "Friend";
      await redis.createUserProfile(chatId, displayName);

      await telegram.sendMessage(
        chatId,
        `Hi ${displayName}! I'm Emi, your Japanese conversation partner! 🌸

I'm here to chat with you in Japanese and help you practice. We can talk about anything - daily life, hobbies, food, travel, or whatever interests you!

Just start chatting in Japanese (or English if you prefer), and I'll match your level. Let's have fun practicing together!

日本語で話しましょう！`,
      );
      res.status(200).json({ ok: true });
      return;
    }

    // Get user input (voice or text)
    let userText: string;

    if (message.voice) {
      await telegram.sendMessage(chatId, "Transcribing...");
      try {
        const filePath = await telegram.getFilePath(message.voice.file_id);
        const audioBuffer = await telegram.downloadFile(filePath);
        userText = await transcribeAudio(audioBuffer);
        await telegram.sendMessage(chatId, `_"${userText}"_`);
      } catch (error) {
        console.error("Transcription error:", error);
        await telegram.sendMessage(chatId, "Sorry, couldn't transcribe. Try again or send text.");
        res.status(200).json({ ok: true });
        return;
      }
    } else if (message.text) {
      userText = message.text;
    } else {
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /debug command
    if (userText.trim().toLowerCase() === "/debug") {
      await handleDebugCommand(chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /reset commands
    const resetMatch = userText
      .trim()
      .toLowerCase()
      .match(/^\/reset\s*(all|context)?$/);
    if (resetMatch) {
      const resetType = resetMatch[1] || "context"; // default to context if no argument
      await handleResetCommand(chatId, resetType as "all" | "context");
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /checkin commands
    const checkinMatch = userText
      .trim()
      .toLowerCase()
      .match(/^\/checkin\s*(on|off|status)?$/);
    if (checkinMatch) {
      const action = checkinMatch[1] || "status";
      await handleCheckInCommand(chatId, action as "on" | "off" | "status");
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /eng command (translate last message)
    if (userText.trim().toLowerCase() === "/eng") {
      await handleTranslateCommand(chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Get conversation context and memory
    const [conversationData, profile, memory, emiMemory] = await Promise.all([
      redis.getConversationData(chatId),
      redis.getUserProfile(chatId),
      redis.getLongTermMemory(chatId),
      redis.getEmiMemory(),
    ]);

    // Filter out command messages from history for cleaner context
    const filteredMessages = redis.filterCommandMessages(conversationData.messages);

    const context: ConversationContext = {
      messages: filteredMessages,
      summary: conversationData.summary,
      memory,
      emiMemory,
    };

    // Parse intent (simplified - mostly just conversation)
    const intent = await parseIntent(userText, filteredMessages);
    console.log(`[${chatId}] Intent: ${intent.type}`);

    // Generate response
    const result = await generateConversationResponse(
      userText,
      context,
      profile?.japaneseLevel || "beginner",
    );

    // Execute any memory tool calls
    if (result.memoryToolCalls.length > 0) {
      await executeMemoryToolCalls(chatId, result.memoryToolCalls);
    }

    // Send response
    await telegram.sendMessage(chatId, result.response);

    // Save to conversation history
    await redis.addToConversation(chatId, userText, result.response);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    if (chatId) {
      try {
        await telegram.sendMessage(chatId, "Something went wrong. Try again?");
      } catch {}
    }
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleResetCommand(chatId: number, type: "all" | "context"): Promise<void> {
  if (type === "all") {
    await Promise.all([
      redis.clearConversation(chatId),
      redis.saveLongTermMemory(chatId, { facts: [], updatedAt: Date.now() }),
      redis.saveEmiMemory({ facts: [], updatedAt: Date.now() }),
    ]);

    await telegram.sendMessage(
      chatId,
      "All cleared! Conversation history, your memory, and my memory have been reset. Let's start fresh!",
    );
  } else {
    await redis.clearConversation(chatId);

    await telegram.sendMessage(
      chatId,
      "Conversation history cleared! My memories about you (and about myself) are still intact.",
    );
  }
}

async function handleTranslateCommand(chatId: number): Promise<void> {
  // Get conversation history to find the last assistant message
  const conversationData = await redis.getConversationData(chatId);
  const messages = conversationData.messages;

  // Find the last assistant message
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");

  if (!lastAssistantMessage) {
    await telegram.sendMessage(chatId, "No previous message to translate.");
    return;
  }

  const translation = await translateToEnglish(lastAssistantMessage.content);
  await telegram.sendMessage(chatId, `_${translation}_`);
}

async function handleCheckInCommand(
  chatId: number,
  action: "on" | "off" | "status",
): Promise<void> {
  const schedule = await redis.getProactiveSchedule(chatId);

  if (action === "status") {
    if (!schedule || !schedule.enabled) {
      await telegram.sendMessage(
        chatId,
        `Proactive check-ins are currently *OFF*.

Use \`/checkin on\` to enable daily messages from me! I'll reach out once a day at a random time between ${schedule?.earliestHour || 9}:00 and ${schedule?.latestHour || 21}:00 to chat.`,
      );
    } else {
      const nextTime = new Date(schedule.scheduledFor).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: schedule.timezone,
      });
      await telegram.sendMessage(
        chatId,
        `Proactive check-ins are *ON*!

Next check-in: ${nextTime}
Time window: ${schedule.earliestHour}:00 - ${schedule.latestHour}:00
Timezone: ${schedule.timezone}

Use \`/checkin off\` to disable.`,
      );
    }
    return;
  }

  if (action === "on") {
    // Check if already enabled
    if (schedule?.enabled) {
      const nextTime = new Date(schedule.scheduledFor).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: schedule.timezone,
      });
      await telegram.sendMessage(
        chatId,
        `Check-ins are already enabled! I'll message you around ${nextTime}.`,
      );
      return;
    }

    // Schedule the first check-in
    try {
      const timezone = process.env.USER_TIMEZONE || "America/Mexico_City";
      const checkIn = await scheduleProactiveCheckIn({
        chatId,
        timezone,
      });

      await redis.createProactiveSchedule(chatId, checkIn.messageId, checkIn.scheduledFor, {
        timezone,
      });

      const nextTime = new Date(checkIn.scheduledFor).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: timezone,
      });

      await telegram.sendMessage(
        chatId,
        `Yay! Check-ins enabled! 🐕

I'll message you once a day at a random time. My first check-in will be around ${nextTime}.

Looking forward to chatting with you! わくわく！`,
      );
    } catch (error) {
      console.error(`[${chatId}] Failed to enable check-ins:`, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await telegram.sendMessage(
        chatId,
        `Sorry, I couldn't enable check-ins: ${errorMsg}`,
      );
    }
    return;
  }

  if (action === "off") {
    if (!schedule || !schedule.enabled) {
      await telegram.sendMessage(chatId, "Check-ins are already disabled.");
      return;
    }

    // Cancel the scheduled message and disable
    try {
      await cancelScheduledMessage(schedule.qstashMessageId);
    } catch {
      // Message might have already been processed
    }

    await redis.disableProactiveSchedule(chatId);

    await telegram.sendMessage(
      chatId,
      `Check-ins disabled. I won't message you unprompted anymore.

Use \`/checkin on\` if you change your mind! いつでも待ってるよ！`,
    );
  }
}

async function handleDebugCommand(chatId: number): Promise<void> {
  const [profile, conversationData, memory, emiMemory, proactiveSchedule] = await Promise.all([
    redis.getUserProfile(chatId),
    redis.getConversationData(chatId),
    redis.getLongTermMemory(chatId),
    redis.getEmiMemory(),
    redis.getProactiveSchedule(chatId),
  ]);

  const debugInfo = {
    profile: profile
      ? {
          displayName: profile.displayName,
          japaneseLevel: profile.japaneseLevel,
          preferredTopics: profile.preferredTopics,
        }
      : null,
    conversation: {
      messageCount: conversationData.messages.length,
      hasSummary: !!conversationData.summary,
      summaryLength: conversationData.summary?.length || 0,
    },
    userMemory: {
      factCount: memory.facts.length,
      facts: memory.facts.map((f) => ({
        id: f.id,
        category: f.category,
        content: f.content,
      })),
    },
    emiMemory: {
      factCount: emiMemory.facts.length,
      facts: emiMemory.facts.map((f) => ({
        id: f.id,
        category: f.category,
        content: f.content,
      })),
    },
    proactiveCheckIns: proactiveSchedule
      ? {
          enabled: proactiveSchedule.enabled,
          nextCheckIn: proactiveSchedule.enabled
            ? new Date(proactiveSchedule.scheduledFor).toISOString()
            : null,
          timeWindow: `${proactiveSchedule.earliestHour}:00 - ${proactiveSchedule.latestHour}:00`,
          timezone: proactiveSchedule.timezone,
          lastCheckIn: proactiveSchedule.lastCheckIn
            ? new Date(proactiveSchedule.lastCheckIn).toISOString()
            : null,
        }
      : { enabled: false },
  };

  await telegram.sendMessage(
    chatId,
    `Debug:\n\`\`\`json\n${JSON.stringify(debugInfo, null, 2)}\n\`\`\``,
  );
}
