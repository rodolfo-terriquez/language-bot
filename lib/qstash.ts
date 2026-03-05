import { Client } from "@upstash/qstash";

let qstashClient: Client | null = null;

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
    console.log(
      `QStash: Could not cancel message ${messageId}, it may have already been processed`,
    );
  }
}

// ==========================================
// Signature Verification
// ==========================================

// ==========================================
// Proactive Check-in Scheduling
// ==========================================

export interface ScheduleCheckInOptions {
  chatId: number;
  /** Earliest hour to send (0-23), default 9 */
  earliestHour?: number;
  /** Latest hour to send (0-23), default 21 */
  latestHour?: number;
  /** Timezone for the hours, default from env USER_TIMEZONE */
  timezone?: string;
  /** Delay in seconds from now (for testing), if set overrides random time */
  delaySeconds?: number;
}

export interface ScheduledCheckIn {
  messageId: string;
  chatId: number;
  scheduledFor: number; // Unix timestamp
}

/**
 * Schedule a proactive check-in message at a random time.
 * By default, schedules for a random time between 9am-9pm the next day.
 */
export async function scheduleProactiveCheckIn(
  options: ScheduleCheckInOptions,
): Promise<ScheduledCheckIn> {
  const client = getClient();
  const baseUrl = process.env.BASE_URL || process.env.VERCEL_URL;

  if (!baseUrl) {
    throw new Error("BASE_URL or VERCEL_URL is required for scheduling");
  }

  const notifyUrl = baseUrl.startsWith("http")
    ? `${baseUrl}/api/notify`
    : `https://${baseUrl}/api/notify`;

  let scheduledTime: Date;

  if (options.delaySeconds !== undefined) {
    // For testing: schedule after a specific delay
    scheduledTime = new Date(Date.now() + options.delaySeconds * 1000);
  } else {
    // Calculate random time for tomorrow within awake hours
    const timezone = options.timezone || process.env.USER_TIMEZONE || "America/Mexico_City";
    const earliestHour = options.earliestHour ?? 9;
    const latestHour = options.latestHour ?? 21;

    scheduledTime = getRandomTimeInRange(earliestHour, latestHour, timezone);
  }

  const payload = {
    chatId: options.chatId,
    type: "proactive_checkin",
  };

  // Calculate delay in seconds from now
  const delaySeconds = Math.max(0, Math.floor((scheduledTime.getTime() - Date.now()) / 1000));

  const response = await client.publishJSON({
    url: notifyUrl,
    body: payload,
    delay: delaySeconds,
  });

  console.log(
    `[QStash] Scheduled proactive check-in for chat ${options.chatId} at ${scheduledTime.toISOString()} (in ${delaySeconds}s), messageId: ${response.messageId}`,
  );

  return {
    messageId: response.messageId,
    chatId: options.chatId,
    scheduledFor: scheduledTime.getTime(),
  };
}

/**
 * Get a random time between earliestHour and latestHour for tomorrow in the given timezone.
 */
function getRandomTimeInRange(earliestHour: number, latestHour: number, timezone: string): Date {
  // Get current time in the target timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Parse current time in timezone
  const parts = formatter.formatToParts(now);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || "0";

  const currentHour = parseInt(getPart("hour"), 10);
  const currentMinute = parseInt(getPart("minute"), 10);
  const currentDay = parseInt(getPart("day"), 10);
  const currentMonth = parseInt(getPart("month"), 10);
  const currentYear = parseInt(getPart("year"), 10);

  // Generate random hour and minute
  const randomHour = earliestHour + Math.floor(Math.random() * (latestHour - earliestHour));
  const randomMinute = Math.floor(Math.random() * 60);

  // Determine if we should schedule for today or tomorrow
  let targetDay = currentDay;
  const randomTimeInMinutes = randomHour * 60 + randomMinute;
  const currentTimeInMinutes = currentHour * 60 + currentMinute;

  // If the random time has already passed today, schedule for tomorrow
  if (randomTimeInMinutes <= currentTimeInMinutes + 30) {
    // +30 min buffer
    targetDay = currentDay + 1;
  }

  // Create a date string in the timezone and convert to UTC
  // We'll use a simple approach: create the date and adjust
  const targetDate = new Date(
    Date.UTC(currentYear, currentMonth - 1, targetDay, randomHour, randomMinute),
  );

  // Adjust for timezone offset
  const utcFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Get the offset by comparing what we want vs what we get
  const testParts = utcFormatter.formatToParts(targetDate);
  const testHour = parseInt(testParts.find((p) => p.type === "hour")?.value || "0", 10);
  const hourDiff = testHour - randomHour;

  // Adjust the date by the offset
  targetDate.setUTCHours(targetDate.getUTCHours() - hourDiff);

  return targetDate;
}

// ==========================================
// Signature Verification
// ==========================================

export async function verifySignature(signature: string, body: string): Promise<boolean> {
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
