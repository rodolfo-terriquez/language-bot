import { readFileSync } from "fs";
import { join } from "path";
import type { TaeKimLesson, TaeKimLessonContent } from "./types.js";

// Cache for curriculum data
let curriculumCache: TaeKimCurriculum | null = null;

interface TaeKimCurriculum {
  version: string;
  source: string;
  totalLessons: number;
  lessons: TaeKimLesson[];
}

/**
 * Load the Tae Kim curriculum data
 */
export function loadCurriculum(): TaeKimCurriculum {
  if (curriculumCache) {
    return curriculumCache;
  }

  const curriculumPath = join(
    process.cwd(),
    "data",
    "grammar",
    "tae-kim-curriculum.json"
  );

  const data = readFileSync(curriculumPath, "utf-8");
  curriculumCache = JSON.parse(data) as TaeKimCurriculum;

  return curriculumCache;
}

/**
 * Get a specific lesson by number (1-indexed)
 */
export function getLesson(lessonNumber: number): TaeKimLesson | null {
  const curriculum = loadCurriculum();
  return curriculum.lessons.find((l) => l.lessonNumber === lessonNumber) || null;
}

/**
 * Get a lesson by topic ID
 */
export function getLessonByTopicId(topicId: string): TaeKimLesson | null {
  const curriculum = loadCurriculum();
  return curriculum.lessons.find((l) => l.topicId === topicId) || null;
}

/**
 * Get a lesson by topic name (case-insensitive partial match)
 */
export function getLessonByTopicName(topicName: string): TaeKimLesson | null {
  const curriculum = loadCurriculum();
  const searchTerm = topicName.toLowerCase();
  return (
    curriculum.lessons.find((l) => l.topic.toLowerCase().includes(searchTerm)) ||
    null
  );
}

/**
 * Get all lessons
 */
export function getAllLessons(): TaeKimLesson[] {
  const curriculum = loadCurriculum();
  return curriculum.lessons;
}

/**
 * Get total number of lessons
 */
export function getTotalLessons(): number {
  const curriculum = loadCurriculum();
  return curriculum.totalLessons;
}

/**
 * Get lessons that have a specific prerequisite
 */
export function getLessonsWithPrerequisite(topicId: string): TaeKimLesson[] {
  const curriculum = loadCurriculum();
  return curriculum.lessons.filter((l) => l.prerequisites.includes(topicId));
}

/**
 * Check if all prerequisites for a lesson are completed
 */
export function arePrerequisitesMet(
  lessonNumber: number,
  completedLessons: number[]
): boolean {
  const lesson = getLesson(lessonNumber);
  if (!lesson) return false;

  // Get lesson numbers for all prerequisites
  const curriculum = loadCurriculum();
  const prereqLessonNumbers = lesson.prerequisites
    .map((topicId) => curriculum.lessons.find((l) => l.topicId === topicId)?.lessonNumber)
    .filter((n): n is number => n !== undefined);

  // Check if all prerequisites are in completed lessons
  return prereqLessonNumbers.every((prereq) => completedLessons.includes(prereq));
}

/**
 * Get the next recommended lesson based on completed lessons
 */
export function getNextRecommendedLesson(
  completedLessons: number[]
): TaeKimLesson | null {
  const curriculum = loadCurriculum();

  // Find the first lesson that:
  // 1. Is not completed
  // 2. Has all prerequisites met
  for (const lesson of curriculum.lessons) {
    if (completedLessons.includes(lesson.lessonNumber)) {
      continue;
    }

    if (arePrerequisitesMet(lesson.lessonNumber, completedLessons)) {
      return lesson;
    }
  }

  return null;
}

/**
 * Format lesson summary for display
 */
export function formatLessonSummary(lesson: TaeKimLesson): string {
  const patterns = lesson.subPatterns.slice(0, 3).join(", ");
  const more = lesson.subPatterns.length > 3 ? ` (+${lesson.subPatterns.length - 3} more)` : "";
  return `Lesson ${lesson.lessonNumber}: ${lesson.topic}\nPatterns: ${patterns}${more}`;
}

/**
 * Get lessons grouped by difficulty tier
 */
export function getLessonsByTier(): {
  beginner: TaeKimLesson[];
  intermediate: TaeKimLesson[];
  advanced: TaeKimLesson[];
} {
  const curriculum = loadCurriculum();

  return {
    beginner: curriculum.lessons.filter((l) => l.lessonNumber <= 15),
    intermediate: curriculum.lessons.filter(
      (l) => l.lessonNumber > 15 && l.lessonNumber <= 30
    ),
    advanced: curriculum.lessons.filter((l) => l.lessonNumber > 30),
  };
}
