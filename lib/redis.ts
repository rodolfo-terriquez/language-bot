import { Redis } from "@upstash/redis";
import type {
  UserProfile,
  ConversationMessage,
  ConversationData,
  LongTermMemory,
  MemoryFact,
  EmiMemory,
  EmiMemoryFact,
} from "./types.js";

let redisClient: Redis | null = null;

function getClient(): Redis {
  if (!redisClient) {
    redisClient = Redis.fromEnv();
  }
  return redisClient;
}

// Key prefix for multi-project support
const getKeyPrefix = (): string => process.env.REDIS_KEY_PREFIX || "";

// ==========================================
// Key Patterns
// ==========================================

const USER_PROFILE_KEY = (chatId: number) => `${getKeyPrefix()}user:${chatId}`;
const CONVERSATION_KEY = (chatId: number) => `${getKeyPrefix()}conversation:${chatId}`;
const ACTIVE_CHATS_KEY = () => `${getKeyPrefix()}active_chats`;
const PROCESSED_MESSAGE_KEY = (chatId: number, messageId: number) =>
  `${getKeyPrefix()}processed:${chatId}:${messageId}`;
const LAST_ASSISTANT_MSG_KEY = (chatId: number) => `${getKeyPrefix()}last_assistant_msg:${chatId}`;
const LONG_TERM_MEMORY_KEY = (chatId: number) => `${getKeyPrefix()}memory:${chatId}`;
const EMI_MEMORY_KEY = () => `${getKeyPrefix()}emi_memory`;

// ==========================================
// User Profile Operations
// ==========================================

export async function createUserProfile(chatId: number, displayName: string): Promise<UserProfile> {
  const redis = getClient();
  const now = Date.now();

  const profile: UserProfile = {
    chatId,
    displayName,
    japaneseLevel: "beginner",
    preferredTopics: [],
    createdAt: now,
    updatedAt: now,
  };

  await redis.set(USER_PROFILE_KEY(chatId), JSON.stringify(profile));
  return profile;
}

export async function getUserProfile(chatId: number): Promise<UserProfile | null> {
  const redis = getClient();
  const data = await redis.get<string>(USER_PROFILE_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateUserProfile(profile: UserProfile): Promise<void> {
  const redis = getClient();
  profile.updatedAt = Date.now();
  await redis.set(USER_PROFILE_KEY(profile.chatId), JSON.stringify(profile));
}

// ==========================================
// Message Idempotency
// ==========================================

export async function tryMarkMessageProcessed(
  chatId: number,
  messageId: number,
  ttlSeconds = 120,
): Promise<boolean> {
  const redis = getClient();
  const key = PROCESSED_MESSAGE_KEY(chatId, messageId);
  const result = await (redis as any).set(key, "1", { nx: true, ex: ttlSeconds });
  return result === "OK";
}

export async function getLastAssistantMessage(
  chatId: number,
): Promise<{ text: string; timestamp: number } | null> {
  const redis = getClient();
  const raw = await redis.get<string>(LAST_ASSISTANT_MSG_KEY(chatId));
  if (!raw) return null;
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (data && typeof data.text === "string" && typeof data.timestamp === "number") {
      return data;
    }
  } catch {}
  return null;
}

export async function setLastAssistantMessage(
  chatId: number,
  text: string,
  ttlSeconds = 600,
): Promise<void> {
  const redis = getClient();
  const payload = JSON.stringify({ text, timestamp: Date.now() });
  await (redis as any).set(LAST_ASSISTANT_MSG_KEY(chatId), payload, { ex: ttlSeconds });
}

// ==========================================
// Conversation History Operations
// ==========================================

const MAX_CONVERSATION_PAIRS = 30;
const RECENT_PAIRS_TO_KEEP = 10;

export async function getConversationData(chatId: number): Promise<ConversationData> {
  const redis = getClient();
  const data = await redis.get<string>(CONVERSATION_KEY(chatId));

  if (!data) return { messages: [] };

  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (Array.isArray(parsed)) {
      return { messages: parsed };
    }
    return parsed as ConversationData;
  } catch {
    return { messages: [] };
  }
}

export async function getConversationHistory(chatId: number): Promise<ConversationMessage[]> {
  const data = await getConversationData(chatId);
  return data.messages;
}

// Callback for triggering summarization (set by the caller to avoid circular imports)
let summarizationCallback:
  | ((messages: ConversationMessage[], existingSummary?: string) => Promise<string>)
  | null = null;

export function setSummarizationCallback(
  callback: (messages: ConversationMessage[], existingSummary?: string) => Promise<string>,
): void {
  summarizationCallback = callback;
}

export async function addToConversation(
  chatId: number,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);

  const conversationData = await getConversationData(chatId);
  const { messages, summary } = conversationData;

  const now = Date.now();
  messages.push(
    { role: "user", content: userMessage, timestamp: now },
    { role: "assistant", content: assistantResponse, timestamp: now },
  );

  const messagePairs = messages.length / 2;

  if (messagePairs >= MAX_CONVERSATION_PAIRS && summarizationCallback) {
    const messagesToSummarize = messages.slice(
      0,
      (MAX_CONVERSATION_PAIRS - RECENT_PAIRS_TO_KEEP) * 2,
    );
    const recentMessages = messages.slice(-(RECENT_PAIRS_TO_KEEP * 2));

    const tempData: ConversationData = {
      messages: recentMessages,
      summary,
      summaryUpdatedAt: conversationData.summaryUpdatedAt,
    };
    await redis.set(key, JSON.stringify(tempData));

    summarizationCallback(messagesToSummarize, summary)
      .then(async (newSummary) => {
        const currentData = await getConversationData(chatId);
        const updatedData: ConversationData = {
          messages: currentData.messages,
          summary: newSummary,
          summaryUpdatedAt: Date.now(),
        };
        await redis.set(key, JSON.stringify(updatedData));
      })
      .catch((err) => {
        console.error("Failed to generate conversation summary:", err);
      });
  } else {
    const updatedData: ConversationData = {
      messages,
      summary,
      summaryUpdatedAt: conversationData.summaryUpdatedAt,
    };
    await redis.set(key, JSON.stringify(updatedData));
  }
}

export async function clearConversation(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(CONVERSATION_KEY(chatId));
}

// ==========================================
// Active Chats Tracking
// ==========================================

export async function registerChat(chatId: number): Promise<boolean> {
  const redis = getClient();
  const added = await redis.sadd(ACTIVE_CHATS_KEY(), chatId.toString());
  return added === 1;
}

export async function getActiveChats(): Promise<number[]> {
  const redis = getClient();
  const chatIds = await redis.smembers<string[]>(ACTIVE_CHATS_KEY());
  return (chatIds || []).map((id) => parseInt(id, 10));
}

// ==========================================
// Long-Term Memory Operations
// ==========================================

export async function getLongTermMemory(chatId: number): Promise<LongTermMemory> {
  const redis = getClient();
  const data = await redis.get<string>(LONG_TERM_MEMORY_KEY(chatId));

  if (!data) {
    return { facts: [], updatedAt: Date.now() };
  }

  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    return parsed as LongTermMemory;
  } catch {
    return { facts: [], updatedAt: Date.now() };
  }
}

export async function saveLongTermMemory(chatId: number, memory: LongTermMemory): Promise<void> {
  const redis = getClient();
  memory.updatedAt = Date.now();
  await redis.set(LONG_TERM_MEMORY_KEY(chatId), JSON.stringify(memory));
}

export async function addMemoryFact(
  chatId: number,
  category: MemoryFact["category"],
  content: string,
): Promise<MemoryFact> {
  const memory = await getLongTermMemory(chatId);
  const now = Date.now();

  const fact: MemoryFact = {
    id: `fact_${now}_${Math.random().toString(36).substr(2, 9)}`,
    category,
    content,
    createdAt: now,
    updatedAt: now,
  };

  memory.facts.push(fact);
  await saveLongTermMemory(chatId, memory);
  return fact;
}

export async function updateMemoryFact(
  chatId: number,
  factId: string,
  content: string,
): Promise<boolean> {
  const memory = await getLongTermMemory(chatId);
  const fact = memory.facts.find((f) => f.id === factId);

  if (!fact) return false;

  fact.content = content;
  fact.updatedAt = Date.now();
  await saveLongTermMemory(chatId, memory);
  return true;
}

export async function deleteMemoryFact(chatId: number, factId: string): Promise<boolean> {
  const memory = await getLongTermMemory(chatId);
  const index = memory.facts.findIndex((f) => f.id === factId);

  if (index === -1) return false;

  memory.facts.splice(index, 1);
  await saveLongTermMemory(chatId, memory);
  return true;
}

export async function getMemoryFactsByCategory(
  chatId: number,
  category: MemoryFact["category"],
): Promise<MemoryFact[]> {
  const memory = await getLongTermMemory(chatId);
  return memory.facts.filter((f) => f.category === category);
}

// ==========================================
// Emi's Self-Memory Operations
// ==========================================

export async function getEmiMemory(): Promise<EmiMemory> {
  const redis = getClient();
  const data = await redis.get<string>(EMI_MEMORY_KEY());

  if (!data) {
    return { facts: [], updatedAt: Date.now() };
  }

  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    return parsed as EmiMemory;
  } catch {
    return { facts: [], updatedAt: Date.now() };
  }
}

export async function saveEmiMemory(memory: EmiMemory): Promise<void> {
  const redis = getClient();
  memory.updatedAt = Date.now();
  await redis.set(EMI_MEMORY_KEY(), JSON.stringify(memory));
}

export async function addEmiMemoryFact(
  category: EmiMemoryFact["category"],
  content: string,
): Promise<EmiMemoryFact> {
  const memory = await getEmiMemory();
  const now = Date.now();

  const fact: EmiMemoryFact = {
    id: `emi_${now}_${Math.random().toString(36).substr(2, 9)}`,
    category,
    content,
    createdAt: now,
    updatedAt: now,
  };

  memory.facts.push(fact);
  await saveEmiMemory(memory);
  return fact;
}

export async function updateEmiMemoryFact(factId: string, content: string): Promise<boolean> {
  const memory = await getEmiMemory();
  const fact = memory.facts.find((f) => f.id === factId);

  if (!fact) return false;

  fact.content = content;
  fact.updatedAt = Date.now();
  await saveEmiMemory(memory);
  return true;
}

export async function deleteEmiMemoryFact(factId: string): Promise<boolean> {
  const memory = await getEmiMemory();
  const index = memory.facts.findIndex((f) => f.id === factId);

  if (index === -1) return false;

  memory.facts.splice(index, 1);
  await saveEmiMemory(memory);
  return true;
}
