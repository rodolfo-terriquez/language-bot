import type {
  LessonPhase,
  ActiveLessonState,
  LessonProgress,
  SyllabusDay,
  VocabularyItem,
  GrammarPattern,
  KanjiItem,
  CurrentExercise,
  ExerciseType,
} from "./types.js";
import * as redis from "./redis.js";
import * as syllabus from "./syllabus.js";

// ==========================================
// Phase Transition Logic
// ==========================================

/**
 * Phase flow:
 * idle -> intro -> vocabulary_teaching -> vocabulary_practice
 *      -> grammar_teaching -> grammar_practice
 *      -> kanji_teaching -> kanji_practice (if kanji exist)
 *      -> assessment -> complete (if pass) / review (if fail)
 *      -> review -> assessment (retry)
 */

const PHASE_ORDER: LessonPhase[] = [
  "idle",
  "intro",
  "vocabulary_teaching",
  "vocabulary_practice",
  "grammar_teaching",
  "grammar_practice",
  "kanji_teaching",
  "kanji_practice",
  "assessment",
  "complete",
];

export interface LessonEngineResult {
  phase: LessonPhase;
  message?: string;
  data?: {
    vocabularyItem?: VocabularyItem;
    grammarPattern?: GrammarPattern;
    kanjiItem?: KanjiItem;
    exercise?: CurrentExercise;
    index?: number;
    total?: number;
    score?: number;
    passed?: boolean;
  };
}

// ==========================================
// Lesson Lifecycle
// ==========================================

/**
 * Start a new lesson for a specific day
 */
export async function startLesson(
  chatId: number,
  dayNumber: number,
): Promise<LessonEngineResult> {
  // Load syllabus content
  const dayContent = await syllabus.getSyllabusDay(dayNumber);
  if (!dayContent) {
    return {
      phase: "idle",
      message: `Could not load content for Day ${dayNumber}`,
    };
  }

  // Start lesson progress tracking
  await redis.startLesson(chatId, dayNumber);

  // Create active lesson state starting with intro
  const vocabIds = dayContent.vocabulary.map((v) => v.id);
  await redis.createActiveLessonState(chatId, dayNumber, "intro", vocabIds);

  return {
    phase: "intro",
    data: {
      index: 0,
      total: dayContent.vocabulary.length + dayContent.grammar.length + dayContent.kanji.length,
    },
  };
}

/**
 * Advance to the next phase of the lesson
 */
export async function advancePhase(chatId: number): Promise<LessonEngineResult> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return { phase: "idle", message: "No active lesson" };
  }

  const dayContent = await syllabus.getSyllabusDay(state.dayNumber);
  if (!dayContent) {
    return { phase: "idle", message: "Could not load lesson content" };
  }

  const currentPhaseIndex = PHASE_ORDER.indexOf(state.phase);
  let nextPhase = PHASE_ORDER[currentPhaseIndex + 1] || "complete";

  // Skip kanji phases if no kanji in this day
  if (
    (nextPhase === "kanji_teaching" || nextPhase === "kanji_practice") &&
    dayContent.kanji.length === 0
  ) {
    nextPhase = "assessment";
  }

  // Prepare items for the next phase
  let newItems: string[] = [];
  switch (nextPhase) {
    case "vocabulary_teaching":
    case "vocabulary_practice":
      newItems = dayContent.vocabulary.map((v) => v.id);
      break;
    case "grammar_teaching":
    case "grammar_practice":
      newItems = dayContent.grammar.map((g) => g.id);
      break;
    case "kanji_teaching":
    case "kanji_practice":
      newItems = dayContent.kanji.map((k) => k.id);
      break;
    case "review":
      newItems = state.pendingReviewItems;
      break;
  }

  await redis.advancePhase(chatId, nextPhase, newItems.length > 0 ? newItems : undefined);

  return { phase: nextPhase };
}

/**
 * Get the current teaching item based on phase and index
 */
export async function getCurrentTeachingItem(
  chatId: number,
): Promise<LessonEngineResult> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return { phase: "idle", message: "No active lesson" };
  }

  const dayContent = await syllabus.getSyllabusDay(state.dayNumber);
  if (!dayContent) {
    return { phase: state.phase, message: "Could not load content" };
  }

  const index = state.currentItemIndex;

  switch (state.phase) {
    case "vocabulary_teaching": {
      const item = dayContent.vocabulary[index];
      if (!item) {
        // All vocabulary taught, advance to practice
        return advancePhase(chatId);
      }
      return {
        phase: state.phase,
        data: {
          vocabularyItem: item,
          index,
          total: dayContent.vocabulary.length,
        },
      };
    }

    case "grammar_teaching": {
      const item = dayContent.grammar[index];
      if (!item) {
        return advancePhase(chatId);
      }
      return {
        phase: state.phase,
        data: {
          grammarPattern: item,
          index,
          total: dayContent.grammar.length,
        },
      };
    }

    case "kanji_teaching": {
      const item = dayContent.kanji[index];
      if (!item) {
        return advancePhase(chatId);
      }
      return {
        phase: state.phase,
        data: {
          kanjiItem: item,
          index,
          total: dayContent.kanji.length,
        },
      };
    }

    default:
      return { phase: state.phase };
  }
}

/**
 * Advance to the next item in the current teaching phase
 */
export async function advanceToNextItem(chatId: number): Promise<LessonEngineResult> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return { phase: "idle", message: "No active lesson" };
  }

  // Increment the item index
  state.currentItemIndex += 1;
  await redis.updateActiveLessonState(state);

  // Get the next item
  return getCurrentTeachingItem(chatId);
}

// ==========================================
// Exercise Generation
// ==========================================

/**
 * Generate an exercise for the current practice phase
 */
export async function generateExercise(chatId: number): Promise<LessonEngineResult> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return { phase: "idle", message: "No active lesson" };
  }

  const dayContent = await syllabus.getSyllabusDay(state.dayNumber);
  if (!dayContent) {
    return { phase: state.phase, message: "Could not load content" };
  }

  // Get items to practice
  let items: Array<{ id: string; type: "vocabulary" | "grammar" | "kanji" }> = [];

  switch (state.phase) {
    case "vocabulary_practice":
      items = dayContent.vocabulary.map((v) => ({ id: v.id, type: "vocabulary" as const }));
      break;
    case "grammar_practice":
      items = dayContent.grammar.map((g) => ({ id: g.id, type: "grammar" as const }));
      break;
    case "kanji_practice":
      items = dayContent.kanji.map((k) => ({ id: k.id, type: "kanji" as const }));
      break;
    case "review":
      // Review pending items
      for (const itemId of state.pendingReviewItems) {
        if (itemId.startsWith("v")) items.push({ id: itemId, type: "vocabulary" });
        else if (itemId.startsWith("g")) items.push({ id: itemId, type: "grammar" });
        else if (itemId.startsWith("k")) items.push({ id: itemId, type: "kanji" });
      }
      break;
    case "assessment":
      // Assessment includes all items from the day
      items = [
        ...dayContent.vocabulary.map((v) => ({ id: v.id, type: "vocabulary" as const })),
        ...dayContent.grammar.map((g) => ({ id: g.id, type: "grammar" as const })),
        ...dayContent.kanji.map((k) => ({ id: k.id, type: "kanji" as const })),
      ];
      break;
    default:
      return { phase: state.phase, message: "Not in a practice phase" };
  }

  if (items.length === 0) {
    // No items to practice, advance phase
    return advancePhase(chatId);
  }

  // Check if we've practiced enough items
  const totalPracticed = state.correctThisSession + state.incorrectThisSession;
  const targetPractice = Math.min(items.length * 2, 10); // Practice each item ~2x, max 10

  if (state.phase !== "assessment" && totalPracticed >= targetPractice) {
    return advancePhase(chatId);
  }

  // For assessment, practice each item once
  if (state.phase === "assessment" && totalPracticed >= items.length) {
    return calculateAssessmentScore(chatId);
  }

  // Pick a random item (with bias toward items needing review)
  const itemToTest = pickItemForPractice(items, state.pendingReviewItems);

  // Generate exercise based on item type
  const exercise = await createExerciseForItem(
    itemToTest.id,
    itemToTest.type,
    dayContent,
    state.phase === "assessment",
  );

  // Save current exercise to state
  state.currentExercise = exercise;
  await redis.updateActiveLessonState(state);

  return {
    phase: state.phase,
    data: {
      exercise,
      index: totalPracticed + 1,
      total: state.phase === "assessment" ? items.length : targetPractice,
    },
  };
}

function pickItemForPractice(
  items: Array<{ id: string; type: "vocabulary" | "grammar" | "kanji" }>,
  pendingReviewItems: string[],
): { id: string; type: "vocabulary" | "grammar" | "kanji" } {
  // 30% chance to pick a pending review item if any exist
  if (pendingReviewItems.length > 0 && Math.random() < 0.3) {
    const reviewId = pendingReviewItems[Math.floor(Math.random() * pendingReviewItems.length)];
    const reviewItem = items.find((i) => i.id === reviewId);
    if (reviewItem) return reviewItem;
  }

  // Otherwise pick randomly
  return items[Math.floor(Math.random() * items.length)];
}

async function createExerciseForItem(
  itemId: string,
  itemType: "vocabulary" | "grammar" | "kanji",
  dayContent: SyllabusDay,
  isAssessment: boolean,
): Promise<CurrentExercise> {
  let exerciseType: ExerciseType = "translation_to_english";
  let prompt: string = "";
  let expectedAnswers: string[] = [];
  let hints: string[] = [];

  if (itemType === "vocabulary") {
    const vocab = dayContent.vocabulary.find((v) => v.id === itemId)!;

    // Randomly choose exercise type
    const types: ExerciseType[] = ["translation_to_english", "translation_to_japanese", "reading_practice"];
    exerciseType = types[Math.floor(Math.random() * types.length)];

    switch (exerciseType) {
      case "translation_to_english":
        prompt = `What does "${vocab.japanese}" mean?`;
        expectedAnswers = [vocab.meaning.toLowerCase()];
        hints = [
          `It's a ${vocab.partOfSpeech}`,
          `It starts with "${vocab.meaning.charAt(0)}"`,
          `The answer is: ${vocab.meaning}`,
        ];
        break;
      case "translation_to_japanese":
        prompt = `How do you say "${vocab.meaning}" in Japanese?`;
        expectedAnswers = [vocab.japanese, vocab.reading.toLowerCase()];
        hints = [
          `The reading is "${vocab.reading}"`,
          `It starts with "${vocab.japanese.charAt(0)}"`,
          `The answer is: ${vocab.japanese}`,
        ];
        break;
      case "reading_practice":
        prompt = `How do you read "${vocab.japanese}"?`;
        expectedAnswers = [vocab.reading.toLowerCase()];
        hints = [
          `It has ${vocab.reading.split(" ").length} syllable(s)`,
          `It starts with "${vocab.reading.split(" ")[0]?.charAt(0) || vocab.reading.charAt(0)}"`,
          `The reading is: ${vocab.reading}`,
        ];
        break;
    }
  } else if (itemType === "grammar") {
    const grammar = dayContent.grammar.find((g) => g.id === itemId)!;
    exerciseType = "grammar_formation";

    // Ask about the grammar pattern meaning
    prompt = `What does the pattern "${grammar.pattern}" mean or express?`;
    expectedAnswers = [grammar.meaning.toLowerCase()];
    hints = [
      `It's used for: ${grammar.formation}`,
      `Example: ${grammar.examples[0]?.japanese || ""}`,
      `The meaning is: ${grammar.meaning}`,
    ];
  } else {
    // kanji
    const kanji = dayContent.kanji.find((k) => k.id === itemId)!;

    const types: ExerciseType[] = ["kanji_reading", "kanji_meaning"];
    exerciseType = types[Math.floor(Math.random() * types.length)];

    if (exerciseType === "kanji_reading") {
      prompt = `How do you read the kanji "${kanji.character}"?`;
      expectedAnswers = [
        ...kanji.readings.onyomi.map((r) => r.toLowerCase()),
        ...kanji.readings.kunyomi.map((r) => r.toLowerCase()),
      ];
      hints = [
        `It has ${kanji.strokeCount} strokes`,
        `On'yomi: ${kanji.readings.onyomi.join(", ")}`,
        `Kun'yomi: ${kanji.readings.kunyomi.join(", ")}`,
      ];
    } else {
      prompt = `What does the kanji "${kanji.character}" mean?`;
      expectedAnswers = kanji.meanings.map((m) => m.toLowerCase());
      hints = [
        `It has ${kanji.strokeCount} strokes`,
        `It starts with "${kanji.meanings[0]?.charAt(0) || ""}"`,
        `The meaning is: ${kanji.meanings.join(", ")}`,
      ];
    }
  }

  return {
    type: exerciseType,
    prompt,
    expectedAnswers,
    hints,
    hintsGiven: 0,
    attempts: 0,
    itemId,
    itemType,
  };
}

// ==========================================
// Answer Evaluation
// ==========================================

export interface AnswerResult {
  isCorrect: boolean;
  isPartiallyCorrect: boolean;
  feedback: string;
  correctAnswer: string;
  shouldAdvance: boolean;
}

/**
 * Evaluate a user's answer to the current exercise
 */
export async function evaluateAnswer(
  chatId: number,
  userAnswer: string,
): Promise<AnswerResult> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state || !state.currentExercise) {
    return {
      isCorrect: false,
      isPartiallyCorrect: false,
      feedback: "No active exercise",
      correctAnswer: "",
      shouldAdvance: false,
    };
  }

  const exercise = state.currentExercise;
  const normalizedAnswer = userAnswer.toLowerCase().trim();
  const expectedAnswers = exercise.expectedAnswers.map((a) => a.toLowerCase().trim());

  // Check for exact match
  const isExactMatch = expectedAnswers.some((expected) => expected === normalizedAnswer);

  // Check for partial match (answer contains expected or vice versa)
  const isPartialMatch = expectedAnswers.some(
    (expected) =>
      normalizedAnswer.includes(expected) ||
      expected.includes(normalizedAnswer) ||
      fuzzyMatch(normalizedAnswer, expected),
  );

  exercise.attempts += 1;

  let result: AnswerResult;

  if (isExactMatch) {
    result = {
      isCorrect: true,
      isPartiallyCorrect: false,
      feedback: "Correct!",
      correctAnswer: exercise.expectedAnswers[0],
      shouldAdvance: true,
    };
    await redis.recordExerciseResult(chatId, true, exercise.itemId);
    await redis.updateItemMastery(
      chatId,
      exercise.itemId,
      exercise.itemType,
      true,
      state.dayNumber,
    );
  } else if (isPartialMatch && exercise.attempts === 1) {
    result = {
      isCorrect: false,
      isPartiallyCorrect: true,
      feedback: "Almost! Try to be more precise.",
      correctAnswer: exercise.expectedAnswers[0],
      shouldAdvance: false,
    };
  } else {
    result = {
      isCorrect: false,
      isPartiallyCorrect: false,
      feedback: `The correct answer is: ${exercise.expectedAnswers[0]}`,
      correctAnswer: exercise.expectedAnswers[0],
      shouldAdvance: exercise.attempts >= 2, // Move on after 2 wrong attempts
    };

    if (result.shouldAdvance) {
      await redis.recordExerciseResult(chatId, false, exercise.itemId);
      await redis.updateItemMastery(
        chatId,
        exercise.itemId,
        exercise.itemType,
        false,
        state.dayNumber,
      );
    }
  }

  // Clear exercise if advancing
  if (result.shouldAdvance) {
    state.currentExercise = undefined;
  }

  await redis.updateActiveLessonState(state);
  return result;
}

/**
 * Simple fuzzy matching for Japanese romaji variations
 */
function fuzzyMatch(answer: string, expected: string): boolean {
  // Remove common variations
  const normalize = (s: string) =>
    s
      .replace(/ou/g, "o")
      .replace(/oo/g, "o")
      .replace(/uu/g, "u")
      .replace(/\s+/g, "")
      .replace(/-/g, "")
      .replace(/'/g, "");

  return normalize(answer) === normalize(expected);
}

/**
 * Get a hint for the current exercise
 */
export async function getHint(chatId: number): Promise<string | null> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state || !state.currentExercise) {
    return null;
  }

  const exercise = state.currentExercise;
  const hintIndex = exercise.hintsGiven;

  if (hintIndex >= exercise.hints.length) {
    return exercise.hints[exercise.hints.length - 1]; // Return last hint
  }

  exercise.hintsGiven += 1;
  state.hintsUsedThisSession += 1;
  await redis.updateActiveLessonState(state);

  return exercise.hints[hintIndex];
}

// ==========================================
// Assessment & Completion
// ==========================================

/**
 * Calculate the final assessment score
 */
export async function calculateAssessmentScore(chatId: number): Promise<LessonEngineResult> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return { phase: "idle", message: "No active lesson" };
  }

  const total = state.correctThisSession + state.incorrectThisSession;
  const score = total > 0 ? Math.round((state.correctThisSession / total) * 100) : 0;
  const passed = score >= 70;

  if (passed) {
    // Complete the lesson
    const lessonProgress = await redis.getLessonProgress(chatId, state.dayNumber);
    await redis.completeLesson(chatId, state.dayNumber, {
      vocabularyScore: score,
      grammarScore: score,
      kanjiScore: score,
    });

    // Advance to next day
    await redis.advanceToNextDay(chatId);

    // Clear active state
    await redis.clearActiveLessonState(chatId);

    return {
      phase: "complete",
      data: {
        score,
        passed: true,
      },
    };
  } else {
    // Need to review weak items
    await redis.advancePhase(chatId, "review", state.pendingReviewItems);

    return {
      phase: "review",
      data: {
        score,
        passed: false,
      },
    };
  }
}

/**
 * Skip the current exercise and mark for review
 */
export async function skipExercise(chatId: number): Promise<void> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state || !state.currentExercise) return;

  const exercise = state.currentExercise;

  // Mark as incorrect and add to review
  await redis.recordExerciseResult(chatId, false, exercise.itemId);

  // Clear current exercise
  state.currentExercise = undefined;
  await redis.updateActiveLessonState(state);
}

/**
 * Get lesson summary/status
 */
export async function getLessonStatus(chatId: number): Promise<{
  inProgress: boolean;
  dayNumber?: number;
  phase?: LessonPhase;
  progress?: {
    correct: number;
    incorrect: number;
    hintsUsed: number;
  };
} | null> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return { inProgress: false };
  }

  return {
    inProgress: true,
    dayNumber: state.dayNumber,
    phase: state.phase,
    progress: {
      correct: state.correctThisSession,
      incorrect: state.incorrectThisSession,
      hintsUsed: state.hintsUsedThisSession,
    },
  };
}
