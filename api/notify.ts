import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { NotificationPayload } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import * as redis from "../lib/redis.js";
import { verifySignature } from "../lib/qstash.js";
import {
  generateDailyLessonPrompt,
  generateWeeklyProgress,
  ConversationContext,
} from "../lib/llm.js";

// Helper to get conversation context for a chat
async function getContext(chatId: number): Promise<ConversationContext> {
  const conversationData = await redis.getConversationData(chatId);
  return {
    messages: conversationData.messages.slice(-10),
    summary: conversationData.summary,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
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

    switch (payload.type) {
      case "daily_lesson":
        await handleDailyLesson(payload.chatId);
        break;

      case "streak_reminder":
        await handleStreakReminder(payload.chatId);
        break;

      case "weekly_progress":
        await handleWeeklyProgress(payload.chatId);
        break;

      case "follow_up_nudge":
        if (payload.dayNumber) {
          await handleFollowUpNudge(payload.chatId, payload.dayNumber);
        }
        break;

      case "lesson_complete":
        // This is typically triggered programmatically after a lesson
        // Could be used for delayed celebration messages
        break;

      default:
        console.warn(`Unknown notification type: ${payload.type}`);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Notify error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ==========================================
// Notification Handlers
// ==========================================

async function handleDailyLesson(chatId: number): Promise<void> {
  const profile = await redis.getUserProfile(chatId);
  if (!profile) {
    console.log(`[Notify] No profile found for chat ${chatId}`);
    return;
  }

  // Check if they already completed today's lesson
  const todayKey = new Date().toISOString().split("T")[0];
  if (profile.lastLessonDate === todayKey) {
    console.log(`[Notify] User ${chatId} already completed today's lesson`);
    return;
  }

  // Check if all 30 days are complete
  if (profile.currentDay > 30) {
    console.log(`[Notify] User ${chatId} has completed all lessons`);
    return;
  }

  // Get conversation context for personalized message
  const context = await getContext(chatId);

  const message = await generateDailyLessonPrompt(
    profile.currentDay,
    profile.currentStreak,
    context,
  );

  await telegram.sendMessage(chatId, message);
  console.log(`[Notify] Sent daily lesson prompt to ${chatId} for Day ${profile.currentDay}`);
}

async function handleStreakReminder(chatId: number): Promise<void> {
  const profile = await redis.getUserProfile(chatId);
  if (!profile) return;

  // Only send if they have an active streak to protect
  if (profile.currentStreak < 2) return;

  // Check if they already completed today's lesson
  const todayKey = new Date().toISOString().split("T")[0];
  if (profile.lastLessonDate === todayKey) {
    console.log(`[Notify] User ${chatId} already active today, skipping streak reminder`);
    return;
  }

  const message = `Hey ${profile.displayName}! You have a ${profile.currentStreak}-day streak going. Don't forget to do today's lesson to keep it alive!`;

  await telegram.sendMessage(chatId, message);
  console.log(`[Notify] Sent streak reminder to ${chatId} (${profile.currentStreak} day streak)`);
}

async function handleWeeklyProgress(chatId: number): Promise<void> {
  const profile = await redis.getUserProfile(chatId);
  if (!profile) return;

  const masteredCounts = await redis.getMasteredItemCount(chatId);

  // Get conversation context
  const context = await getContext(chatId);

  // Calculate days completed this week (simplified)
  const completedLessons = await redis.getCompletedLessons(chatId);
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentLessons = completedLessons.filter(
    (l) => l.completedAt && l.completedAt > oneWeekAgo,
  );
  const daysCompletedThisWeek = recentLessons.length;

  const message = await generateWeeklyProgress(
    daysCompletedThisWeek,
    profile.currentStreak,
    masteredCounts.vocabulary,
    masteredCounts.grammar,
    masteredCounts.kanji,
    context,
  );

  await telegram.sendMessage(chatId, message);
  console.log(`[Notify] Sent weekly progress to ${chatId}`);
}

async function handleFollowUpNudge(chatId: number, dayNumber: number): Promise<void> {
  // Check if they still have an active (paused) lesson
  const activeState = await redis.getActiveLessonState(chatId);
  if (!activeState || activeState.dayNumber !== dayNumber) {
    console.log(`[Notify] No matching active lesson for follow-up nudge`);
    return;
  }

  const profile = await redis.getUserProfile(chatId);
  const displayName = profile?.displayName || "there";

  const message = `Hey ${displayName}! Just checking in - you paused your Day ${dayNumber} lesson earlier. Ready to continue? Just say "resume" when you're back!`;

  await telegram.sendMessage(chatId, message);
  console.log(`[Notify] Sent follow-up nudge to ${chatId} for Day ${dayNumber}`);
}
