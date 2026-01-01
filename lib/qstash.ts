import { Client } from "@upstash/qstash";
import type { NotificationPayload } from "./types.js";

let qstashClient: Client | null = null;

// Get user's timezone from env (defaults to America/Mexico_City)
function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || "America/Mexico_City";
}

// Prepend CRON_TZ to cron expression for timezone-aware scheduling
function withTimezone(cronExpression: string): string {
  const tz = getUserTimezone();
  return `CRON_TZ=${tz} ${cronExpression}`;
}

function getClient(): Client {
  if (!qstashClient) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) {
      throw new Error("QSTASH_TOKEN is not set");
    }
    qstashClient = new Client({ token });
  }
  return qstashClient;
}

function getNotifyUrl(): string {
  // Prefer BASE_URL (stable production URL) over VERCEL_URL (deployment-specific)
  const baseUrl =
    process.env.BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!baseUrl) {
    throw new Error("BASE_URL or VERCEL_URL is not set");
  }

  return `${baseUrl}/api/notify`;
}

// ==========================================
// Language Bot Scheduling Functions
// ==========================================

/**
 * Schedule daily lesson prompt at user's preferred time
 */
export async function scheduleDailyLesson(
  chatId: number,
  cronExpression: string = "0 9 * * *", // 9 AM daily by default
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    type: "daily_lesson",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  console.log(`QStash: Created daily_lesson schedule ${schedule.scheduleId} for chat ${chatId}`);
  return schedule.scheduleId;
}

/**
 * Schedule streak reminder (sent 2 hours before lesson time if no activity)
 */
export async function scheduleStreakReminder(
  chatId: number,
  cronExpression: string,
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    type: "streak_reminder",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  console.log(`QStash: Created streak_reminder schedule ${schedule.scheduleId} for chat ${chatId}`);
  return schedule.scheduleId;
}

/**
 * Schedule weekly progress summary (Sunday evenings)
 */
export async function scheduleWeeklyProgress(
  chatId: number,
  cronExpression: string = "0 18 * * 0", // 6 PM on Sundays
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    type: "weekly_progress",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  console.log(`QStash: Created weekly_progress schedule ${schedule.scheduleId} for chat ${chatId}`);
  return schedule.scheduleId;
}

/**
 * Schedule a one-time follow-up nudge (after pausing a lesson)
 */
export async function scheduleFollowUpNudge(
  chatId: number,
  dayNumber: number,
  delayMinutes: number = 10,
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    type: "follow_up_nudge",
    dayNumber,
  };

  const result = await client.publishJSON({
    url: notifyUrl,
    body: payload,
    delay: delayMinutes * 60, // Convert to seconds
    retries: 3,
  });

  console.log(`QStash: Scheduled follow_up_nudge ${result.messageId} for chat ${chatId}`);
  return result.messageId;
}

/**
 * Schedule a one-time lesson complete celebration
 */
export async function scheduleLessonComplete(
  chatId: number,
  dayNumber: number,
  delayMinutes: number = 0,
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    type: "lesson_complete",
    dayNumber,
  };

  const result = await client.publishJSON({
    url: notifyUrl,
    body: payload,
    delay: delayMinutes * 60, // Convert to seconds
    retries: 3,
  });

  console.log(`QStash: Scheduled lesson_complete ${result.messageId} for chat ${chatId}`);
  return result.messageId;
}

// ==========================================
// Schedule Management
// ==========================================

export async function deleteSchedule(scheduleId: string): Promise<void> {
  const client = getClient();
  try {
    await client.schedules.delete(scheduleId);
    console.log(`QStash: Deleted schedule ${scheduleId}`);
  } catch {
    console.log(`QStash: Could not delete schedule ${scheduleId}, it may not exist`);
  }
}

export interface QStashScheduleInfo {
  scheduleId: string;
  destination: string;
  cron: string;
  body: string;
  createdAt: number;
  isPaused: boolean;
}

export async function listAllSchedules(): Promise<QStashScheduleInfo[]> {
  const client = getClient();
  try {
    const schedules = await client.schedules.list();
    return schedules.map((s) => ({
      scheduleId: s.scheduleId,
      destination: s.destination,
      cron: s.cron || "",
      body: s.body || "",
      createdAt: s.createdAt,
      isPaused: s.isPaused || false,
    }));
  } catch (error) {
    console.error("Error listing QStash schedules:", error);
    return [];
  }
}

export async function cancelScheduledMessage(messageId: string): Promise<void> {
  const client = getClient();
  try {
    await client.messages.delete(messageId);
    console.log(`QStash: Cancelled message ${messageId}`);
  } catch {
    console.log(`QStash: Could not cancel message ${messageId}, it may have already been processed`);
  }
}

// ==========================================
// Signature Verification
// ==========================================

export async function verifySignature(
  signature: string,
  body: string,
): Promise<boolean> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey) {
    console.warn("QStash signing keys not set, skipping verification");
    return true; // Skip verification in development
  }

  const { Receiver } = await import("@upstash/qstash");
  const receiver = new Receiver({
    currentSigningKey,
    nextSigningKey,
  });

  try {
    await receiver.verify({
      signature,
      body,
    });
    return true;
  } catch {
    return false;
  }
}
