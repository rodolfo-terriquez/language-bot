import { readFileSync } from "fs";
import { join } from "path";
import type { CoreVocabItem, VocabProgress, VocabProgressMap } from "./types.js";
import * as redis from "./redis.js";

// Cache for vocabulary data
let vocabularyCache: CoreVocabItem[] | null = null;

/**
 * Extended vocabulary progress entry with full tracking
 * (Matches Python vocab_manager.py functionality)
 */
export interface VocabProgressEntry {
  word: string;
  reading: string;
  definition: string;
  coreRank: number;
  status: "new" | "learning" | "known" | "ignored";
  firstSeenDate: string | null;
  lastSeenDate: string | null;
  timesSeen: number;
  timesCorrect: number;
  sourceLessons: number[];
  notes: string;
}

export type VocabProgressData = Record<string, VocabProgressEntry>;

/**
 * Load vocabulary from core_2.3k.csv
 */
export function loadCoreVocabulary(): CoreVocabItem[] {
  if (vocabularyCache) {
    return vocabularyCache;
  }

  const csvPath = join(process.cwd(), "core_2.3k.csv");
  const data = readFileSync(csvPath, "utf-8");

  const lines = data.split("\n");
  const items: CoreVocabItem[] = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line (handle quoted fields with commas)
    const fields = parseCSVLine(line);
    if (fields.length >= 5) {
      items.push({
        word: fields[0],
        furigana: fields[1],
        definition: fields[2],
        exampleJapanese: fields[3],
        exampleEnglish: fields[4],
        rank: i, // 1-indexed position = frequency rank
      });
    }
  }

  vocabularyCache = items;
  return items;
}

/**
 * Parse a CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Get vocabulary by rank range
 */
export function getVocabularyByRank(startRank: number, endRank: number): CoreVocabItem[] {
  const vocabulary = loadCoreVocabulary();
  return vocabulary.filter((v) => v.rank >= startRank && v.rank <= endRank);
}

/**
 * Get a specific word by rank
 */
export function getWordByRank(rank: number): CoreVocabItem | null {
  const vocabulary = loadCoreVocabulary();
  return vocabulary.find((v) => v.rank === rank) || null;
}

/**
 * Search vocabulary by word or definition
 */
export function searchVocabulary(query: string): CoreVocabItem[] {
  const vocabulary = loadCoreVocabulary();
  const searchTerm = query.toLowerCase();

  return vocabulary.filter(
    (v) =>
      v.word.includes(query) ||
      v.furigana.includes(query) ||
      v.definition.toLowerCase().includes(searchTerm),
  );
}

/**
 * Get the next N unseen/low-seen words for a user
 * Prioritizes: unseen first, then least-seen, all by frequency rank
 */
export async function getNextVocabulary(
  chatId: number,
  count: number = 20,
): Promise<CoreVocabItem[]> {
  const vocabulary = loadCoreVocabulary();
  const progress = await redis.getVocabProgress(chatId);

  // Separate vocabulary into categories
  const unseen: CoreVocabItem[] = [];
  const lowSeen: CoreVocabItem[] = [];
  const learning: CoreVocabItem[] = [];

  for (const item of vocabulary) {
    const wordProgress = progress[item.word];

    if (!wordProgress || wordProgress.timesSeen === 0) {
      unseen.push(item);
    } else if (wordProgress.status === "learning" && wordProgress.timesSeen < 5) {
      lowSeen.push(item);
    } else if (wordProgress.status === "learning") {
      learning.push(item);
    }
    // Skip "known" and "ignored" words
  }

  // Take from unseen first (already sorted by rank), then low-seen
  const result: CoreVocabItem[] = [];

  // Add unseen words (highest priority, ordered by rank)
  for (const item of unseen) {
    if (result.length >= count) break;
    result.push(item);
  }

  // If we need more, add low-seen words
  if (result.length < count) {
    // Sort by timesSeen (ascending) then by rank
    lowSeen.sort((a, b) => {
      const aSeen = progress[a.word]?.timesSeen || 0;
      const bSeen = progress[b.word]?.timesSeen || 0;
      if (aSeen !== bSeen) return aSeen - bSeen;
      return a.rank - b.rank;
    });

    for (const item of lowSeen) {
      if (result.length >= count) break;
      result.push(item);
    }
  }

  // If we still need more, add learning words
  if (result.length < count) {
    learning.sort((a, b) => a.rank - b.rank);
    for (const item of learning) {
      if (result.length >= count) break;
      result.push(item);
    }
  }

  return result;
}

/**
 * Mark vocabulary as seen in a lesson
 * @param chatId - User's chat ID
 * @param words - List of words to mark as seen
 * @param lessonNumber - Optional lesson number for tracking source lessons
 */
export async function markVocabularySeen(
  chatId: number,
  words: string[],
  lessonNumber?: number,
): Promise<void> {
  for (const word of words) {
    await redis.updateVocabSeen(chatId, word, lessonNumber);
  }
}

/**
 * Mark vocabulary as correctly recalled
 * Auto-promotes to "known" if success rate >= 80% and correct >= 3 times
 * (Matches Python vocab_manager.py logic)
 */
export async function markVocabularyCorrect(chatId: number, words: string[]): Promise<void> {
  for (const word of words) {
    await redis.updateVocabCorrect(chatId, word);
  }
}

/**
 * Get vocabulary words that need review based on spaced repetition
 * Returns words that have been seen but not yet mastered
 */
export async function getReviewVocabulary(
  chatId: number,
  count: number = 5,
): Promise<CoreVocabItem[]> {
  const vocabulary = loadCoreVocabulary();
  const progress = await redis.getVocabProgress(chatId);

  // Find words that need review: seen, learning status, not yet mastered
  const reviewCandidates: { item: CoreVocabItem; priority: number }[] = [];

  for (const item of vocabulary) {
    const wordProgress = progress[item.word];
    if (!wordProgress) continue;

    // Only include words in "learning" status
    if (wordProgress.status !== "learning") continue;

    // Calculate review priority based on:
    // - Lower accuracy = higher priority
    // - More time since last seen = higher priority
    const total = wordProgress.timesSeen;
    const accuracy = total > 0 ? wordProgress.timesCorrect / total : 0;
    const daysSinceLastSeen = wordProgress.lastSeen
      ? (Date.now() - wordProgress.lastSeen) / (1000 * 60 * 60 * 24)
      : 0;

    // Priority formula: lower accuracy and longer time = higher priority
    const priority = (1 - accuracy) * 5 + daysSinceLastSeen * 0.5;

    reviewCandidates.push({ item, priority });
  }

  // Sort by priority descending and take top N
  reviewCandidates.sort((a, b) => b.priority - a.priority);
  return reviewCandidates.slice(0, count).map((c) => c.item);
}

/**
 * Get a mix of new and review vocabulary for a lesson
 * @param chatId - User's chat ID
 * @param newCount - Number of new words to include
 * @param reviewCount - Number of review words to include
 */
export async function getLessonVocabulary(
  chatId: number,
  newCount: number = 15,
  reviewCount: number = 5,
): Promise<{ newWords: CoreVocabItem[]; reviewWords: CoreVocabItem[] }> {
  const [newWords, reviewWords] = await Promise.all([
    getNextVocabulary(chatId, newCount),
    getReviewVocabulary(chatId, reviewCount),
  ]);

  return { newWords, reviewWords };
}

/**
 * Set vocabulary status
 */
export async function setVocabularyStatus(
  chatId: number,
  word: string,
  status: VocabProgress["status"],
): Promise<void> {
  await redis.setVocabStatus(chatId, word, status);
}

/**
 * Get vocabulary progress summary for a user
 */
export async function getVocabularyProgressSummary(chatId: number): Promise<{
  totalInCurriculum: number;
  totalSeen: number;
  totalLearning: number;
  totalKnown: number;
  totalIgnored: number;
  nextWordsPreview: CoreVocabItem[];
}> {
  const vocabulary = loadCoreVocabulary();
  const progress = await redis.getVocabProgress(chatId);

  let totalSeen = 0;
  let totalLearning = 0;
  let totalKnown = 0;
  let totalIgnored = 0;

  for (const word of Object.keys(progress)) {
    const p = progress[word];
    if (p.timesSeen > 0) totalSeen++;
    if (p.status === "learning") totalLearning++;
    if (p.status === "known") totalKnown++;
    if (p.status === "ignored") totalIgnored++;
  }

  const nextWordsPreview = await getNextVocabulary(chatId, 5);

  return {
    totalInCurriculum: vocabulary.length,
    totalSeen,
    totalLearning,
    totalKnown,
    totalIgnored,
    nextWordsPreview,
  };
}

/**
 * Get total vocabulary count
 */
export function getTotalVocabularyCount(): number {
  const vocabulary = loadCoreVocabulary();
  return vocabulary.length;
}

/**
 * Format vocabulary item for display in lesson
 */
export function formatVocabForLesson(item: CoreVocabItem): string {
  return `${item.word} (${item.furigana}) - ${item.definition}
Example: ${item.exampleJapanese}
${item.exampleEnglish}`;
}

/**
 * Get vocabulary items that match a specific grammar pattern
 * (for finding vocabulary that uses certain constructions)
 */
export function getVocabularyWithPattern(pattern: string): CoreVocabItem[] {
  const vocabulary = loadCoreVocabulary();
  return vocabulary.filter((v) => v.exampleJapanese.includes(pattern) || v.word.includes(pattern));
}
