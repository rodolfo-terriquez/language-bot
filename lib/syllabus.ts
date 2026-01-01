import { promises as fs } from "fs";
import * as path from "path";
import type { SyllabusDay, N5Syllabus } from "./types.js";
import * as redis from "./redis.js";

// Path to syllabus data directory
const SYLLABUS_DIR = path.join(process.cwd(), "data", "syllabus", "n5");

// Cache for loaded syllabus data (in-memory for performance)
let syllabusCache: Map<number, SyllabusDay> | null = null;
let syllabusMetaCache: N5Syllabus | null = null;

/**
 * Load a specific day's syllabus content
 */
export async function getSyllabusDay(dayNumber: number): Promise<SyllabusDay | null> {
  // Try in-memory cache first
  if (syllabusCache?.has(dayNumber)) {
    return syllabusCache.get(dayNumber)!;
  }

  // Try Redis cache
  const cachedDay = await redis.getCachedSyllabusDay("n5", dayNumber);
  if (cachedDay) {
    // Store in memory cache too
    if (!syllabusCache) syllabusCache = new Map();
    syllabusCache.set(dayNumber, cachedDay);
    return cachedDay;
  }

  // Load from file
  try {
    const filePath = path.join(SYLLABUS_DIR, "days", `day${String(dayNumber).padStart(2, "0")}.json`);
    const content = await fs.readFile(filePath, "utf-8");
    const day = JSON.parse(content) as SyllabusDay;

    // Validate and set day number
    day.dayNumber = dayNumber;

    // Cache in memory and Redis
    if (!syllabusCache) syllabusCache = new Map();
    syllabusCache.set(dayNumber, day);
    await redis.cacheSyllabusDay("n5", day);

    return day;
  } catch (error) {
    console.error(`Failed to load syllabus day ${dayNumber}:`, error);
    return null;
  }
}

/**
 * Load the full syllabus metadata
 */
export async function getSyllabusMeta(): Promise<N5Syllabus | null> {
  if (syllabusMetaCache) {
    return syllabusMetaCache;
  }

  try {
    const filePath = path.join(SYLLABUS_DIR, "index.json");
    const content = await fs.readFile(filePath, "utf-8");
    syllabusMetaCache = JSON.parse(content) as N5Syllabus;
    return syllabusMetaCache;
  } catch (error) {
    console.error("Failed to load syllabus metadata:", error);
    return null;
  }
}

/**
 * Get all vocabulary item IDs for a specific day
 */
export async function getVocabularyIds(dayNumber: number): Promise<string[]> {
  const day = await getSyllabusDay(dayNumber);
  if (!day) return [];
  return day.vocabulary.map((v) => v.id);
}

/**
 * Get all grammar pattern IDs for a specific day
 */
export async function getGrammarIds(dayNumber: number): Promise<string[]> {
  const day = await getSyllabusDay(dayNumber);
  if (!day) return [];
  return day.grammar.map((g) => g.id);
}

/**
 * Get all kanji IDs for a specific day
 */
export async function getKanjiIds(dayNumber: number): Promise<string[]> {
  const day = await getSyllabusDay(dayNumber);
  if (!day) return [];
  return day.kanji.map((k) => k.id);
}

/**
 * Get all item IDs for a specific day (vocab + grammar + kanji)
 */
export async function getAllItemIds(dayNumber: number): Promise<{
  vocabulary: string[];
  grammar: string[];
  kanji: string[];
}> {
  const day = await getSyllabusDay(dayNumber);
  if (!day) {
    return { vocabulary: [], grammar: [], kanji: [] };
  }

  return {
    vocabulary: day.vocabulary.map((v) => v.id),
    grammar: day.grammar.map((g) => g.id),
    kanji: day.kanji.map((k) => k.id),
  };
}

/**
 * Look up a vocabulary item by ID across all days
 */
export async function getVocabularyItem(itemId: string): Promise<{
  item: SyllabusDay["vocabulary"][0];
  dayNumber: number;
} | null> {
  // Try to extract day number from item ID (format: v01_01, v02_03, etc.)
  const match = itemId.match(/^v(\d+)_/);
  if (match) {
    const dayNumber = parseInt(match[1], 10);
    const day = await getSyllabusDay(dayNumber);
    if (day) {
      const item = day.vocabulary.find((v) => v.id === itemId);
      if (item) return { item, dayNumber };
    }
  }

  // Fallback: search all loaded days
  if (syllabusCache) {
    for (const [dayNumber, day] of syllabusCache) {
      const item = day.vocabulary.find((v) => v.id === itemId);
      if (item) return { item, dayNumber };
    }
  }

  return null;
}

/**
 * Look up a grammar pattern by ID
 */
export async function getGrammarPattern(itemId: string): Promise<{
  item: SyllabusDay["grammar"][0];
  dayNumber: number;
} | null> {
  const match = itemId.match(/^g(\d+)_/);
  if (match) {
    const dayNumber = parseInt(match[1], 10);
    const day = await getSyllabusDay(dayNumber);
    if (day) {
      const item = day.grammar.find((g) => g.id === itemId);
      if (item) return { item, dayNumber };
    }
  }

  if (syllabusCache) {
    for (const [dayNumber, day] of syllabusCache) {
      const item = day.grammar.find((g) => g.id === itemId);
      if (item) return { item, dayNumber };
    }
  }

  return null;
}

/**
 * Look up a kanji by ID
 */
export async function getKanjiItem(itemId: string): Promise<{
  item: SyllabusDay["kanji"][0];
  dayNumber: number;
} | null> {
  const match = itemId.match(/^k(\d+)_/);
  if (match) {
    const dayNumber = parseInt(match[1], 10);
    const day = await getSyllabusDay(dayNumber);
    if (day) {
      const item = day.kanji.find((k) => k.id === itemId);
      if (item) return { item, dayNumber };
    }
  }

  if (syllabusCache) {
    for (const [dayNumber, day] of syllabusCache) {
      const item = day.kanji.find((k) => k.id === itemId);
      if (item) return { item, dayNumber };
    }
  }

  return null;
}

/**
 * Get lesson summary for display
 */
export async function getLessonSummary(dayNumber: number): Promise<{
  title: string;
  description: string;
  vocabularyCount: number;
  grammarCount: number;
  kanjiCount: number;
  estimatedMinutes: number;
  practiceGoals: string[];
} | null> {
  const day = await getSyllabusDay(dayNumber);
  if (!day) return null;

  return {
    title: day.title,
    description: day.description,
    vocabularyCount: day.vocabulary.length,
    grammarCount: day.grammar.length,
    kanjiCount: day.kanji.length,
    estimatedMinutes: day.estimatedMinutes,
    practiceGoals: day.practiceGoals,
  };
}

/**
 * Clear the in-memory cache (useful for testing)
 */
export function clearCache(): void {
  syllabusCache = null;
  syllabusMetaCache = null;
}
