import { Redis } from "@upstash/redis";
import type {
  UserProfile,
  LessonProgress,
  LessonPhase,
  ActiveLessonState,
  MasteryData,
  ItemMastery,
  WeakArea,
  ConversationMessage,
  ConversationData,
  SyllabusDay,
  LessonChecklist,
} from "./types.js";

let redisClient: Redis | null = null;

function getClient(): Redis {
  if (!redisClient) {
    redisClient = Redis.fromEnv();
  }
  return redisClient;
}

// Key prefix for multi-project support (allows sharing the same Redis instance)
// Use REDIS_KEY_PREFIX=lang: for this bot
const getKeyPrefix = (): string => process.env.REDIS_KEY_PREFIX || "";

// ==========================================
// Key Patterns
// ==========================================

// User profile
const USER_PROFILE_KEY = (chatId: number) => `${getKeyPrefix()}user:${chatId}`;

// Lesson progress (per day)
const LESSON_PROGRESS_KEY = (chatId: number, dayNumber: number) =>
  `${getKeyPrefix()}lesson:${chatId}:day${dayNumber}`;
const LESSONS_SET_KEY = (chatId: number) => `${getKeyPrefix()}lessons:${chatId}`;

// Active lesson state (in-progress session)
const ACTIVE_LESSON_KEY = (chatId: number) => `${getKeyPrefix()}active_lesson:${chatId}`;

// Lesson checklist (for LLM context tracking)
const LESSON_CHECKLIST_KEY = (chatId: number) => `${getKeyPrefix()}checklist:${chatId}`;

// Mastery tracking
const MASTERY_KEY = (chatId: number) => `${getKeyPrefix()}mastery:${chatId}`;

// Conversation history
const CONVERSATION_KEY = (chatId: number) => `${getKeyPrefix()}conversation:${chatId}`;

// Active chats tracking
const ACTIVE_CHATS_KEY = () => `${getKeyPrefix()}active_chats`;

// Processed Telegram messages (idempotency)
const PROCESSED_MESSAGE_KEY = (chatId: number, messageId: number) =>
  `${getKeyPrefix()}processed:${chatId}:${messageId}`;

// Last assistant message per chat (duplicate suppression)
const LAST_ASSISTANT_MSG_KEY = (chatId: number) => `${getKeyPrefix()}last_assistant_msg:${chatId}`;

// Syllabus cache
const SYLLABUS_KEY = (level: string) => `${getKeyPrefix()}syllabus:${level}`;
const SYLLABUS_DAY_KEY = (level: string, dayNumber: number) =>
  `${getKeyPrefix()}syllabus:${level}:day${dayNumber}`;

// ==========================================
// Helpers
// ==========================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getTodayKey(): string {
  return new Date().toISOString().split("T")[0];
}

function getDayOfWeek(): string {
  const timezone = process.env.USER_TIMEZONE || "America/Mexico_City";
  const now = new Date();
  return now.toLocaleDateString("en-US", { weekday: "long", timeZone: timezone }).toLowerCase();
}

// ==========================================
// User Profile Operations
// ==========================================

export async function createUserProfile(chatId: number, displayName: string): Promise<UserProfile> {
  const redis = getClient();
  const now = Date.now();

  const profile: UserProfile = {
    chatId,
    displayName,
    lessonTime: "09:00", // Default lesson time
    timezone: process.env.USER_TIMEZONE || "America/Mexico_City",
    currentDay: 1,
    startDate: now,
    totalLessonsCompleted: 0,
    currentStreak: 0,
    longestStreak: 0,
    preferredInputMode: "both",
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

/**
 * Attempt to mark a Telegram message as processed. Returns true if this is the first time
 * seeing this message (i.e., we should process it), or false if it was already processed.
 * Uses NX + EX to avoid reprocessing on webhook retries or duplicates.
 */
export async function tryMarkMessageProcessed(
  chatId: number,
  messageId: number,
  ttlSeconds = 120,
): Promise<boolean> {
  const redis = getClient();
  const key = PROCESSED_MESSAGE_KEY(chatId, messageId);
  // Upstash Redis supports NX/EX options on SET
  const result = await (redis as any).set(key, "1", { nx: true, ex: ttlSeconds });
  // Result is "OK" on success, null if key already exists
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

export async function setLessonTime(
  chatId: number,
  hour: number,
  minute: number,
): Promise<UserProfile | null> {
  const profile = await getUserProfile(chatId);
  if (!profile) return null;

  profile.lessonTime = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  await updateUserProfile(profile);
  return profile;
}

export async function updateStreak(chatId: number): Promise<UserProfile | null> {
  const profile = await getUserProfile(chatId);
  if (!profile) return null;

  const today = getTodayKey();
  const lastLessonDate = profile.lastLessonDate;

  if (lastLessonDate === today) {
    // Already completed a lesson today, no change
    return profile;
  }

  // Check if yesterday had a lesson
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().split("T")[0];

  if (lastLessonDate === yesterdayKey) {
    // Consecutive day - increment streak
    profile.currentStreak += 1;
  } else {
    // Streak broken - reset to 1
    profile.currentStreak = 1;
  }

  // Update longest streak if needed
  if (profile.currentStreak > profile.longestStreak) {
    profile.longestStreak = profile.currentStreak;
  }

  profile.lastLessonDate = today;
  profile.totalLessonsCompleted += 1;
  await updateUserProfile(profile);

  return profile;
}

export async function advanceToNextDay(chatId: number): Promise<UserProfile | null> {
  const profile = await getUserProfile(chatId);
  if (!profile) return null;

  if (profile.currentDay < 30) {
    profile.currentDay += 1;
    await updateUserProfile(profile);
  }

  return profile;
}

// ==========================================
// Lesson Progress Operations
// ==========================================

export async function createLessonProgress(
  chatId: number,
  dayNumber: number,
): Promise<LessonProgress> {
  const redis = getClient();

  const progress: LessonProgress = {
    chatId,
    dayNumber,
    status: "not_started",
    scheduledDate: getTodayKey(),
    currentPhase: "idle",
    passingGrade: 70,
    totalTimeSpent: 0,
    attemptCount: 0,
  };

  await redis.set(LESSON_PROGRESS_KEY(chatId, dayNumber), JSON.stringify(progress));
  await redis.sadd(LESSONS_SET_KEY(chatId), dayNumber.toString());

  return progress;
}

export async function getLessonProgress(
  chatId: number,
  dayNumber: number,
): Promise<LessonProgress | null> {
  const redis = getClient();
  const data = await redis.get<string>(LESSON_PROGRESS_KEY(chatId, dayNumber));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateLessonProgress(progress: LessonProgress): Promise<void> {
  const redis = getClient();
  await redis.set(
    LESSON_PROGRESS_KEY(progress.chatId, progress.dayNumber),
    JSON.stringify(progress),
  );
}

export async function startLesson(chatId: number, dayNumber: number): Promise<LessonProgress> {
  let progress = await getLessonProgress(chatId, dayNumber);

  if (!progress) {
    progress = await createLessonProgress(chatId, dayNumber);
  }

  progress.status = "in_progress";
  progress.currentPhase = "intro";
  progress.startedAt = Date.now();
  progress.attemptCount += 1;

  await updateLessonProgress(progress);
  return progress;
}

export async function completeLesson(
  chatId: number,
  dayNumber: number,
  scores: {
    vocabularyScore: number;
    grammarScore: number;
    kanjiScore: number;
  },
): Promise<LessonProgress | null> {
  const progress = await getLessonProgress(chatId, dayNumber);
  if (!progress) return null;

  const overallScore = Math.round(
    (scores.vocabularyScore + scores.grammarScore + scores.kanjiScore) / 3,
  );

  progress.status = "completed";
  progress.currentPhase = "complete";
  progress.completedAt = Date.now();
  progress.actualCompletedDate = getTodayKey();
  progress.vocabularyScore = scores.vocabularyScore;
  progress.grammarScore = scores.grammarScore;
  progress.kanjiScore = scores.kanjiScore;
  progress.overallScore = overallScore;

  if (progress.startedAt) {
    progress.totalTimeSpent += Math.round((Date.now() - progress.startedAt) / 60000);
  }

  await updateLessonProgress(progress);

  // Update user streak
  await updateStreak(chatId);

  return progress;
}

export async function getCompletedLessons(chatId: number): Promise<LessonProgress[]> {
  const redis = getClient();
  const dayNumbers = await redis.smembers<string[]>(LESSONS_SET_KEY(chatId));

  if (!dayNumbers || dayNumbers.length === 0) return [];

  const completed: LessonProgress[] = [];
  for (const dayNum of dayNumbers) {
    const progress = await getLessonProgress(chatId, parseInt(dayNum, 10));
    if (progress && progress.status === "completed") {
      completed.push(progress);
    }
  }

  return completed.sort((a, b) => a.dayNumber - b.dayNumber);
}

export async function getMissedLessons(chatId: number): Promise<number[]> {
  const profile = await getUserProfile(chatId);
  if (!profile) return [];

  const missed: number[] = [];
  for (let day = 1; day < profile.currentDay; day++) {
    const progress = await getLessonProgress(chatId, day);
    if (!progress || progress.status !== "completed") {
      missed.push(day);
    }
  }

  return missed;
}

// ==========================================
// Active Lesson State Operations
// ==========================================

const ACTIVE_LESSON_TTL = 24 * 60 * 60; // 24 hours

export async function createActiveLessonState(
  chatId: number,
  dayNumber: number,
  phase: LessonPhase,
  currentItems: string[],
): Promise<ActiveLessonState> {
  const redis = getClient();
  const now = Date.now();

  const state: ActiveLessonState = {
    chatId,
    dayNumber,
    phase,
    currentItems,
    currentItemIndex: 0,
    correctThisSession: 0,
    incorrectThisSession: 0,
    hintsUsedThisSession: 0,
    startedAt: now,
    lastInteraction: now,
    pendingReviewItems: [],
  };

  await redis.set(ACTIVE_LESSON_KEY(chatId), JSON.stringify(state), { ex: ACTIVE_LESSON_TTL });
  return state;
}

export async function getActiveLessonState(chatId: number): Promise<ActiveLessonState | null> {
  const redis = getClient();
  const data = await redis.get<string>(ACTIVE_LESSON_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateActiveLessonState(state: ActiveLessonState): Promise<void> {
  const redis = getClient();
  state.lastInteraction = Date.now();
  await redis.set(ACTIVE_LESSON_KEY(state.chatId), JSON.stringify(state), {
    ex: ACTIVE_LESSON_TTL,
  });
}

export async function clearActiveLessonState(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(ACTIVE_LESSON_KEY(chatId));
}

export async function advancePhase(
  chatId: number,
  newPhase: LessonPhase,
  newItems?: string[],
): Promise<ActiveLessonState | null> {
  const state = await getActiveLessonState(chatId);
  if (!state) return null;

  state.phase = newPhase;
  if (newItems) {
    state.currentItems = newItems;
    state.currentItemIndex = 0;
  }

  await updateActiveLessonState(state);
  return state;
}

export async function recordExerciseResult(
  chatId: number,
  correct: boolean,
  itemId?: string,
): Promise<ActiveLessonState | null> {
  const state = await getActiveLessonState(chatId);
  if (!state) return null;

  if (correct) {
    state.correctThisSession += 1;
  } else {
    state.incorrectThisSession += 1;
    if (itemId && !state.pendingReviewItems.includes(itemId)) {
      state.pendingReviewItems.push(itemId);
    }
  }

  await updateActiveLessonState(state);
  return state;
}

// ==========================================
// Lesson Checklist Operations
// ==========================================

const CHECKLIST_TTL = 24 * 60 * 60; // 24 hours

export async function getLessonChecklist(chatId: number): Promise<LessonChecklist | null> {
  const redis = getClient();
  const data = await redis.get<string>(LESSON_CHECKLIST_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function saveLessonChecklist(checklist: LessonChecklist): Promise<void> {
  const redis = getClient();
  checklist.lastUpdated = Date.now();
  await redis.set(LESSON_CHECKLIST_KEY(checklist.chatId), JSON.stringify(checklist), {
    ex: CHECKLIST_TTL,
  });
}

export async function clearLessonChecklist(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(LESSON_CHECKLIST_KEY(chatId));
}

// ==========================================
// Mastery Tracking Operations
// ==========================================

export async function getMasteryData(chatId: number): Promise<MasteryData> {
  const redis = getClient();
  const data = await redis.get<string>(MASTERY_KEY(chatId));

  if (!data) {
    // Return empty mastery data
    return {
      chatId,
      vocabulary: {},
      grammar: {},
      kanji: {},
      weakAreas: [],
      lastUpdated: Date.now(),
    };
  }

  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function saveMasteryData(mastery: MasteryData): Promise<void> {
  const redis = getClient();
  mastery.lastUpdated = Date.now();
  await redis.set(MASTERY_KEY(mastery.chatId), JSON.stringify(mastery));
}

export async function updateItemMastery(
  chatId: number,
  itemId: string,
  itemType: "vocabulary" | "grammar" | "kanji",
  correct: boolean,
  dayIntroduced: number,
): Promise<ItemMastery> {
  const mastery = await getMasteryData(chatId);
  const category = mastery[itemType];

  let item = category[itemId];
  if (!item) {
    // Create new mastery entry
    item = {
      itemId,
      itemType,
      correctCount: 0,
      incorrectCount: 0,
      lastSeen: Date.now(),
      masteryLevel: 0,
      needsReview: false,
      dayIntroduced,
    };
  }

  // Update counts
  if (correct) {
    item.correctCount += 1;
    item.lastCorrect = Date.now();
  } else {
    item.incorrectCount += 1;
  }
  item.lastSeen = Date.now();

  // Calculate mastery level (0-5 scale based on accuracy)
  const total = item.correctCount + item.incorrectCount;
  if (total >= 3) {
    const accuracy = item.correctCount / total;
    if (accuracy >= 0.9 && item.correctCount >= 5) {
      item.masteryLevel = 5; // Mastered
    } else if (accuracy >= 0.8 && item.correctCount >= 4) {
      item.masteryLevel = 4;
    } else if (accuracy >= 0.7 && item.correctCount >= 3) {
      item.masteryLevel = 3;
    } else if (accuracy >= 0.5) {
      item.masteryLevel = 2;
    } else {
      item.masteryLevel = 1;
    }
  }

  // Mark for review if struggling
  item.needsReview = item.masteryLevel < 3 && item.incorrectCount > item.correctCount;

  category[itemId] = item;
  await saveMasteryData(mastery);

  // Update weak areas
  await updateWeakAreas(chatId, item);

  return item;
}

async function updateWeakAreas(chatId: number, item: ItemMastery): Promise<void> {
  const mastery = await getMasteryData(chatId);

  // Remove from weak areas if mastered
  if (item.masteryLevel >= 3) {
    mastery.weakAreas = mastery.weakAreas.filter((w) => w.itemId !== item.itemId);
  } else if (item.needsReview) {
    // Add or update weak area
    const existingIndex = mastery.weakAreas.findIndex((w) => w.itemId === item.itemId);
    if (existingIndex >= 0) {
      mastery.weakAreas[existingIndex].reviewCount += 1;
    } else {
      mastery.weakAreas.push({
        itemId: item.itemId,
        itemType: item.itemType,
        reviewCount: 1,
        addedAt: Date.now(),
      });
    }
  }

  await saveMasteryData(mastery);
}

export async function getWeakAreas(chatId: number): Promise<WeakArea[]> {
  const mastery = await getMasteryData(chatId);
  return mastery.weakAreas.sort((a, b) => b.reviewCount - a.reviewCount);
}

export async function getItemsNeedingReview(
  chatId: number,
  itemType?: "vocabulary" | "grammar" | "kanji",
): Promise<ItemMastery[]> {
  const mastery = await getMasteryData(chatId);
  const items: ItemMastery[] = [];

  const categories = itemType
    ? [mastery[itemType]]
    : [mastery.vocabulary, mastery.grammar, mastery.kanji];

  for (const category of categories) {
    for (const item of Object.values(category)) {
      if (item.needsReview || item.masteryLevel < 3) {
        items.push(item);
      }
    }
  }

  return items.sort((a, b) => a.masteryLevel - b.masteryLevel);
}

export async function getMasteredItemCount(chatId: number): Promise<{
  vocabulary: number;
  grammar: number;
  kanji: number;
}> {
  const mastery = await getMasteryData(chatId);

  return {
    vocabulary: Object.values(mastery.vocabulary).filter((i) => i.masteryLevel >= 4).length,
    grammar: Object.values(mastery.grammar).filter((i) => i.masteryLevel >= 4).length,
    kanji: Object.values(mastery.kanji).filter((i) => i.masteryLevel >= 4).length,
  };
}

// ==========================================
// Review Candidate Selection (Spaced Repetition)
// ==========================================

export interface ReviewCandidate {
  item: ItemMastery;
  priority: number;
}

/**
 * Get items that should be reviewed based on spaced repetition principles.
 * Priority is calculated based on:
 * - Mastery level (lower = higher priority)
 * - Time since last seen (longer = higher priority)
 * - Error ratio (higher = higher priority)
 */
export async function getReviewCandidates(
  chatId: number,
  currentDayNumber: number,
  limit: number = 5,
): Promise<ReviewCandidate[]> {
  const mastery = await getMasteryData(chatId);
  const candidates: ReviewCandidate[] = [];
  const now = Date.now();

  const calculatePriority = (item: ItemMastery): number => {
    const daysSinceLastSeen = (now - item.lastSeen) / (1000 * 60 * 60 * 24);
    const masteryFactor = 5 - item.masteryLevel;
    const total = item.correctCount + item.incorrectCount;
    const errorRatio = total > 0 ? item.incorrectCount / total : 0;

    // Priority formula: higher = more urgent review needed
    return masteryFactor * 2 + daysSinceLastSeen * 0.5 + errorRatio * 3;
  };

  // Process all categories
  for (const [, items] of [
    ["vocabulary", mastery.vocabulary],
    ["grammar", mastery.grammar],
    ["kanji", mastery.kanji],
  ] as const) {
    for (const item of Object.values(items)) {
      // Skip items from current or future days (not yet taught)
      if (item.dayIntroduced >= currentDayNumber) continue;

      // Include if: low mastery OR hasn't been seen recently
      const daysSinceLastSeen = (now - item.lastSeen) / (1000 * 60 * 60 * 24);
      const needsReview = item.masteryLevel < 3 || (item.masteryLevel < 5 && daysSinceLastSeen > 2);

      if (needsReview) {
        candidates.push({
          item,
          priority: calculatePriority(item),
        });
      }
    }
  }

  // Sort by priority (highest first) and take top N
  return candidates.sort((a, b) => b.priority - a.priority).slice(0, limit);
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
  lessonContext?: { dayNumber: number; phase: LessonPhase },
): Promise<void> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);

  const conversationData = await getConversationData(chatId);
  const { messages, summary } = conversationData;

  const now = Date.now();
  messages.push(
    { role: "user", content: userMessage, timestamp: now, lessonContext },
    { role: "assistant", content: assistantResponse, timestamp: now, lessonContext },
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
// Syllabus Cache Operations
// ==========================================

const SYLLABUS_TTL = 7 * 24 * 60 * 60; // 7 days

export async function cacheSyllabusDay(level: string, day: SyllabusDay): Promise<void> {
  const redis = getClient();
  await redis.set(SYLLABUS_DAY_KEY(level, day.dayNumber), JSON.stringify(day), {
    ex: SYLLABUS_TTL,
  });
}

export async function getCachedSyllabusDay(
  level: string,
  dayNumber: number,
): Promise<SyllabusDay | null> {
  const redis = getClient();
  const data = await redis.get<string>(SYLLABUS_DAY_KEY(level, dayNumber));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

// ==========================================
// Progress Summary for LLM Context
// ==========================================

export interface LessonContext {
  userProfile: UserProfile;
  currentLessonProgress: LessonProgress | null;
  activeLessonState: ActiveLessonState | null;
  weakAreas: WeakArea[];
  itemsNeedingReview: ItemMastery[];
  masteredCounts: { vocabulary: number; grammar: number; kanji: number };
  recentConversation: ConversationMessage[];
  conversationSummary?: string;
}

/**
 * Get comprehensive context for the LLM to generate personalized lessons.
 * This includes:
 * - User's current progress and streak
 * - Current lesson state
 * - Weak areas that need reinforcement
 * - Items needing review
 * - Recent conversation for continuity
 */
export async function getLessonContext(chatId: number): Promise<LessonContext | null> {
  const profile = await getUserProfile(chatId);
  if (!profile) return null;

  const [
    currentLessonProgress,
    activeLessonState,
    weakAreas,
    itemsNeedingReview,
    masteredCounts,
    conversationData,
  ] = await Promise.all([
    getLessonProgress(chatId, profile.currentDay),
    getActiveLessonState(chatId),
    getWeakAreas(chatId),
    getItemsNeedingReview(chatId),
    getMasteredItemCount(chatId),
    getConversationData(chatId),
  ]);

  return {
    userProfile: profile,
    currentLessonProgress,
    activeLessonState,
    weakAreas,
    itemsNeedingReview,
    masteredCounts,
    recentConversation: conversationData.messages.slice(-10), // Last 5 exchanges
    conversationSummary: conversationData.summary,
  };
}

// ==========================================
// Flexible Lesson State (Tae Kim Curriculum)
// ==========================================

import type {
  FlexibleLessonState,
  TaeKimLessonContent,
  TaeKimProgress,
  VocabProgress,
  VocabProgressMap,
} from "./types.js";

// Key patterns for flexible lesson system
const FLEXIBLE_LESSON_KEY = (chatId: number) => `${getKeyPrefix()}flex_lesson:${chatId}`;
const TAEKIM_PROGRESS_KEY = (chatId: number) => `${getKeyPrefix()}taekim_progress:${chatId}`;
const TAEKIM_CONTENT_CACHE_KEY = (lessonNumber: number) =>
  `${getKeyPrefix()}taekim_content:${lessonNumber}`;

const FLEXIBLE_LESSON_TTL = 24 * 60 * 60; // 24 hours
const CONTENT_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

/**
 * Get flexible lesson state
 */
export async function getFlexibleLessonState(chatId: number): Promise<FlexibleLessonState | null> {
  const redis = getClient();
  const data = await redis.get<string>(FLEXIBLE_LESSON_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

/**
 * Save flexible lesson state
 */
export async function saveFlexibleLessonState(state: FlexibleLessonState): Promise<void> {
  const redis = getClient();
  state.lastInteraction = Date.now();
  await redis.set(FLEXIBLE_LESSON_KEY(state.chatId), JSON.stringify(state), {
    ex: FLEXIBLE_LESSON_TTL,
  });
}

/**
 * Clear flexible lesson state
 */
export async function clearFlexibleLessonState(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(FLEXIBLE_LESSON_KEY(chatId));
}

/**
 * Get Tae Kim progress for a user
 */
export async function getTaeKimProgress(chatId: number): Promise<TaeKimProgress> {
  const redis = getClient();
  const data = await redis.get<string>(TAEKIM_PROGRESS_KEY(chatId));

  if (!data) {
    // Return default progress
    return {
      chatId,
      completedLessons: [],
      currentLesson: 1,
      lessonScores: {},
      totalTimeSpent: 0,
    };
  }

  return typeof data === "string" ? JSON.parse(data) : data;
}

/**
 * Save Tae Kim progress
 */
export async function saveTaeKimProgress(progress: TaeKimProgress): Promise<void> {
  const redis = getClient();
  await redis.set(TAEKIM_PROGRESS_KEY(progress.chatId), JSON.stringify(progress));
}

/**
 * Mark a Tae Kim lesson as complete
 */
export async function markTaeKimLessonComplete(
  chatId: number,
  lessonNumber: number,
  score: number,
  timeSpentMinutes: number,
): Promise<TaeKimProgress> {
  const progress = await getTaeKimProgress(chatId);

  // Add to completed if not already
  if (!progress.completedLessons.includes(lessonNumber)) {
    progress.completedLessons.push(lessonNumber);
    progress.completedLessons.sort((a, b) => a - b);
  }

  // Update score (keep best score)
  const existingScore = progress.lessonScores[lessonNumber] || 0;
  progress.lessonScores[lessonNumber] = Math.max(existingScore, score);

  // Update current lesson to next uncompleted
  const maxCompleted = Math.max(...progress.completedLessons, 0);
  progress.currentLesson = maxCompleted + 1;

  // Update time spent
  progress.totalTimeSpent += timeSpentMinutes;
  progress.lastCompletedAt = Date.now();

  await saveTaeKimProgress(progress);

  // Also update user streak
  await updateStreak(chatId);

  return progress;
}

/**
 * Get the next recommended Tae Kim lesson for a user
 */
export async function getNextTaeKimLesson(chatId: number): Promise<number> {
  const progress = await getTaeKimProgress(chatId);
  return progress.currentLesson;
}

/**
 * Check if a user has completed a specific Tae Kim lesson
 */
export async function hasTaeKimLessonCompleted(
  chatId: number,
  lessonNumber: number,
): Promise<boolean> {
  const progress = await getTaeKimProgress(chatId);
  return progress.completedLessons.includes(lessonNumber);
}

/**
 * Cache generated lesson content
 */
export async function cacheTaeKimContent(
  lessonNumber: number,
  content: TaeKimLessonContent,
): Promise<void> {
  const redis = getClient();
  await redis.set(TAEKIM_CONTENT_CACHE_KEY(lessonNumber), JSON.stringify(content), {
    ex: CONTENT_CACHE_TTL,
  });
}

/**
 * Get cached lesson content
 */
export async function getCachedTaeKimContent(
  lessonNumber: number,
): Promise<TaeKimLessonContent | null> {
  const redis = getClient();
  const data = await redis.get<string>(TAEKIM_CONTENT_CACHE_KEY(lessonNumber));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

/**
 * Get comprehensive Tae Kim lesson context
 */
export interface TaeKimLessonContext {
  userProfile: UserProfile;
  taeKimProgress: TaeKimProgress;
  flexibleLessonState: FlexibleLessonState | null;
  recentConversation: ConversationMessage[];
  conversationSummary?: string;
}

export async function getTaeKimLessonContext(chatId: number): Promise<TaeKimLessonContext | null> {
  const profile = await getUserProfile(chatId);
  if (!profile) return null;

  const [taeKimProgress, flexibleLessonState, conversationData] = await Promise.all([
    getTaeKimProgress(chatId),
    getFlexibleLessonState(chatId),
    getConversationData(chatId),
  ]);

  return {
    userProfile: profile,
    taeKimProgress,
    flexibleLessonState,
    recentConversation: conversationData.messages.slice(-10),
    conversationSummary: conversationData.summary,
  };
}

// ==========================================
// Core Vocabulary Progress Tracking
// ==========================================

const VOCAB_PROGRESS_KEY = (chatId: number) => `${getKeyPrefix()}vocab_progress:${chatId}`;

/**
 * Get vocabulary progress for a user
 */
export async function getVocabProgress(chatId: number): Promise<VocabProgressMap> {
  const redis = getClient();
  const data = await redis.get<string>(VOCAB_PROGRESS_KEY(chatId));

  if (!data) {
    return {};
  }

  try {
    return JSON.parse(data) as VocabProgressMap;
  } catch {
    return {};
  }
}

/**
 * Save vocabulary progress for a user
 */
export async function saveVocabProgress(chatId: number, progress: VocabProgressMap): Promise<void> {
  const redis = getClient();
  await redis.set(VOCAB_PROGRESS_KEY(chatId), JSON.stringify(progress));
}

/**
 * Update vocabulary when seen in a lesson
 */
export async function updateVocabSeen(chatId: number, word: string): Promise<void> {
  const progress = await getVocabProgress(chatId);
  const now = Date.now();

  if (!progress[word]) {
    progress[word] = {
      word,
      timesSeen: 1,
      timesCorrect: 0,
      lastSeen: now,
      status: "learning",
    };
  } else {
    progress[word].timesSeen++;
    progress[word].lastSeen = now;
    // Auto-promote to "learning" if was "new"
    if (progress[word].status === "new") {
      progress[word].status = "learning";
    }
  }

  await saveVocabProgress(chatId, progress);
}

/**
 * Update vocabulary when correctly recalled
 */
export async function updateVocabCorrect(chatId: number, word: string): Promise<void> {
  const progress = await getVocabProgress(chatId);
  const now = Date.now();

  if (!progress[word]) {
    progress[word] = {
      word,
      timesSeen: 1,
      timesCorrect: 1,
      lastSeen: now,
      status: "learning",
    };
  } else {
    progress[word].timesCorrect++;
    progress[word].lastSeen = now;

    // Auto-promote to "known" after 5 correct recalls
    if (progress[word].timesCorrect >= 5 && progress[word].status === "learning") {
      progress[word].status = "known";
    }
  }

  await saveVocabProgress(chatId, progress);
}

/**
 * Set vocabulary status directly
 */
export async function setVocabStatus(
  chatId: number,
  word: string,
  status: VocabProgress["status"],
): Promise<void> {
  const progress = await getVocabProgress(chatId);
  const now = Date.now();

  if (!progress[word]) {
    progress[word] = {
      word,
      timesSeen: 0,
      timesCorrect: 0,
      lastSeen: now,
      status,
    };
  } else {
    progress[word].status = status;
  }

  await saveVocabProgress(chatId, progress);
}

/**
 * Get vocabulary stats for a user
 */
export async function getVocabStats(chatId: number): Promise<{
  total: number;
  new: number;
  learning: number;
  known: number;
  ignored: number;
}> {
  const progress = await getVocabProgress(chatId);
  const words = Object.values(progress);

  return {
    total: words.length,
    new: words.filter((w) => w.status === "new").length,
    learning: words.filter((w) => w.status === "learning").length,
    known: words.filter((w) => w.status === "known").length,
    ignored: words.filter((w) => w.status === "ignored").length,
  };
}
