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
