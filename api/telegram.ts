import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import {
  parseIntent,
  generateConversationResponse,
  generateConversationSummary,
  ConversationContext,
  MemoryToolCall,
} from "../lib/llm.js";
import * as redis from "../lib/redis.js";

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

    // Get conversation context and memory
    const [conversationData, profile, memory, emiMemory] = await Promise.all([
      redis.getConversationData(chatId),
      redis.getUserProfile(chatId),
      redis.getLongTermMemory(chatId),
      redis.getEmiMemory(),
    ]);

    const context: ConversationContext = {
      messages: conversationData.messages,
      summary: conversationData.summary,
      memory,
      emiMemory,
    };

    // Parse intent (simplified - mostly just conversation)
    const intent = await parseIntent(userText, conversationData.messages);
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

async function handleDebugCommand(chatId: number): Promise<void> {
  const [profile, conversationData, memory, emiMemory] = await Promise.all([
    redis.getUserProfile(chatId),
    redis.getConversationData(chatId),
    redis.getLongTermMemory(chatId),
    redis.getEmiMemory(),
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
  };

  await telegram.sendMessage(
    chatId,
    `Debug:\n\`\`\`json\n${JSON.stringify(debugInfo, null, 2)}\n\`\`\``,
  );
}
