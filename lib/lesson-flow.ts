import type {
  FlexibleLessonState,
  LessonComponent,
  ComponentProgress,
  TaeKimLessonContent,
} from "./types.js";

// ==========================================
// Component Progress Tracking
// ==========================================

/**
 * Create initial component progress for a new lesson
 */
export function createInitialComponentProgress(): Record<LessonComponent, ComponentProgress> {
  const components: LessonComponent[] = [
    "grammar_intro",
    "vocabulary",
    "kanji",
    "reading_practice",
    "dialogue_practice",
    "exercises",
    "writing_practice",
  ];

  const progress: Record<string, ComponentProgress> = {};
  for (const component of components) {
    progress[component] = {
      status: "not_started",
      itemsIntroduced: 0,
      itemsPracticed: 0,
      correctCount: 0,
      incorrectCount: 0,
    };
  }

  return progress as Record<LessonComponent, ComponentProgress>;
}

/**
 * Create a new flexible lesson state
 */
export function createFlexibleLessonState(
  chatId: number,
  lessonNumber: number,
  topicId: string,
  topic: string,
): FlexibleLessonState {
  return {
    chatId,
    lessonNumber,
    topicId,
    topic,
    currentComponent: "grammar_intro",
    completedComponents: [],
    componentProgress: createInitialComponentProgress(),
    generatedContent: {},
    vocabularyIntroduced: [],
    kanjiIntroduced: [],
    exerciseResults: { correct: 0, incorrect: 0 },
    startedAt: Date.now(),
    lastInteraction: Date.now(),
  };
}

// ==========================================
// Component Navigation
// ==========================================

const COMPONENT_ORDER: LessonComponent[] = [
  "grammar_intro",
  "vocabulary",
  "kanji",
  "reading_practice",
  "dialogue_practice",
  "exercises",
  "writing_practice",
  "complete",
];

/**
 * Get the next component in sequence
 */
export function getNextComponent(current: LessonComponent): LessonComponent {
  const currentIndex = COMPONENT_ORDER.indexOf(current);
  if (currentIndex === -1 || currentIndex >= COMPONENT_ORDER.length - 1) {
    return "complete";
  }
  return COMPONENT_ORDER[currentIndex + 1];
}

/**
 * Suggest the next component based on completed ones
 */
export function suggestNextComponent(
  state: FlexibleLessonState,
  _lesson: TaeKimLessonContent,
): LessonComponent {
  // If current component is not complete, stay on it
  if (!state.completedComponents.includes(state.currentComponent)) {
    return state.currentComponent;
  }

  // Find next incomplete component
  for (const component of COMPONENT_ORDER) {
    if (component === "complete") continue;
    if (!state.completedComponents.includes(component)) {
      return component;
    }
  }

  return "complete";
}

/**
 * Advance to the next component
 */
export function advanceComponent(state: FlexibleLessonState): FlexibleLessonState {
  const nextComponent = getNextComponent(state.currentComponent);

  // Mark current as completed if not already
  if (!state.completedComponents.includes(state.currentComponent)) {
    state.completedComponents.push(state.currentComponent);
  }

  // Update component progress
  if (state.componentProgress[state.currentComponent]) {
    state.componentProgress[state.currentComponent].status = "completed";
  }

  state.currentComponent = nextComponent;
  state.lastInteraction = Date.now();

  // Mark new component as started
  if (nextComponent !== "complete" && state.componentProgress[nextComponent]) {
    state.componentProgress[nextComponent].status = "in_progress";
  }

  return state;
}

// ==========================================
// Progress Tracking
// ==========================================

/**
 * Update lesson progress based on component and progress description
 */
export function updateLessonProgress(
  state: FlexibleLessonState,
  component: LessonComponent,
  progressDescription: string,
): FlexibleLessonState {
  state.lastInteraction = Date.now();

  // Update current component if changed
  if (component !== state.currentComponent) {
    // Mark previous as completed if we're moving forward
    if (!state.completedComponents.includes(state.currentComponent)) {
      state.completedComponents.push(state.currentComponent);
    }
    state.currentComponent = component;
  }

  // Mark component as started
  if (component !== "complete" && state.componentProgress[component]) {
    if (state.componentProgress[component].status === "not_started") {
      state.componentProgress[component].status = "in_progress";
    }
  }

  // Parse progress description for specific updates
  const lowerProgress = progressDescription.toLowerCase();

  // Track vocabulary introduced
  const vocabMatch = lowerProgress.match(/(\d+)\/(\d+)\s*words?\s*introduced/i);
  if (vocabMatch) {
    // This is informational - actual vocab tracked via markVocabularySeen
  }

  // Track exercise results
  const exerciseMatch = lowerProgress.match(/(\d+)\s*correct/i);
  if (exerciseMatch) {
    state.exerciseResults.correct = parseInt(exerciseMatch[1], 10);
  }

  // Check for completion indicators
  if (
    lowerProgress.includes("complete") ||
    lowerProgress.includes("finished") ||
    lowerProgress.includes("done")
  ) {
    if (component !== "complete" && state.componentProgress[component]) {
      state.componentProgress[component].status = "completed";
    }
    if (!state.completedComponents.includes(component) && component !== "complete") {
      state.completedComponents.push(component);
    }
  }

  return state;
}

/**
 * Check if the lesson is complete
 */
export function isLessonComplete(state: FlexibleLessonState): boolean {
  return state.currentComponent === "complete" || state.completedComponents.length >= 7;
}

/**
 * Get progress percentage (0-100)
 */
export function getProgressPercentage(state: FlexibleLessonState): number {
  const totalComponents = COMPONENT_ORDER.length - 1; // Exclude "complete"
  return Math.round((state.completedComponents.length / totalComponents) * 100);
}

/**
 * Get a human-readable progress summary
 */
export function getProgressSummary(state: FlexibleLessonState): string {
  const percentage = getProgressPercentage(state);
  const current = formatComponentName(state.currentComponent);
  const completed = state.completedComponents.length;
  const total = COMPONENT_ORDER.length - 1;

  if (state.currentComponent === "complete") {
    return `Lesson complete! (${completed}/${total} components)`;
  }

  return `${percentage}% complete - Currently: ${current} (${completed}/${total} components)`;
}

/**
 * Format component name for display
 */
function formatComponentName(component: LessonComponent): string {
  const names: Record<LessonComponent, string> = {
    grammar_intro: "Grammar Introduction",
    vocabulary: "Vocabulary",
    kanji: "Kanji",
    reading_practice: "Reading Practice",
    dialogue_practice: "Dialogue Practice",
    exercises: "Exercises",
    writing_practice: "Writing Practice",
    complete: "Complete",
  };
  return names[component] || component;
}

// ==========================================
// Context Building
// ==========================================

/**
 * Build context for the current component
 */
export function buildComponentContext(
  component: LessonComponent,
  lesson: TaeKimLessonContent,
  state: FlexibleLessonState,
): string {
  const contextParts: string[] = [];

  contextParts.push(`## Current Component: ${formatComponentName(component)}`);
  contextParts.push(`## Topic: ${lesson.topic}`);
  contextParts.push(`## Grammar Patterns: ${lesson.subPatterns.join(", ")}`);

  switch (component) {
    case "grammar_intro":
      contextParts.push(`\n## Grammar Explanation:\n${lesson.grammarExplanation}`);
      break;

    case "vocabulary":
      contextParts.push(`\n## Vocabulary to teach (${lesson.vocabulary.length} words):`);
      contextParts.push(
        lesson.vocabulary
          .slice(0, 15)
          .map((v) => `- ${v.japanese} (${v.reading}): ${v.meaning}`)
          .join("\n"),
      );
      if (state.vocabularyIntroduced.length > 0) {
        contextParts.push(`\nAlready introduced: ${state.vocabularyIntroduced.join(", ")}`);
      }
      break;

    case "kanji":
      contextParts.push(`\n## Kanji to teach (${lesson.kanji.length} characters):`);
      contextParts.push(
        lesson.kanji.map((k) => `- ${k.character}: ${k.meanings.join(", ")}`).join("\n"),
      );
      break;

    case "reading_practice":
      if (lesson.readingPassage) {
        contextParts.push(`\n## Reading Passage:`);
        contextParts.push(`Scenario: ${lesson.readingPassage.scenario}`);
        contextParts.push(
          lesson.readingPassage.sentences
            .map((s) => `${s.kanji}\n${s.kana}\n${s.english}`)
            .join("\n\n"),
        );
      }
      break;

    case "dialogue_practice":
      if (lesson.dialoguePractice) {
        contextParts.push(`\n## Dialogue Practice:`);
        contextParts.push(`Scenario: ${lesson.dialoguePractice.scenario}`);
        contextParts.push(`Participants: ${lesson.dialoguePractice.participants.join(", ")}`);
      }
      break;

    case "exercises":
      if (lesson.practiceExercises) {
        contextParts.push(`\n## Practice Exercises (${lesson.practiceExercises.length} total):`);
        contextParts.push(
          `Results so far: ${state.exerciseResults.correct} correct, ${state.exerciseResults.incorrect} incorrect`,
        );
      }
      break;

    case "writing_practice":
      if (lesson.writingExercise) {
        contextParts.push(`\n## Writing Exercise:`);
        contextParts.push(lesson.writingExercise.prompt);
        contextParts.push(
          `Target structures: ${lesson.writingExercise.targetStructures.join(", ")}`,
        );
      }
      break;

    case "complete":
      contextParts.push(`\n## Lesson Complete!`);
      contextParts.push(`Score: ${calculateLessonScore(state)}%`);
      break;
  }

  return contextParts.join("\n");
}

// ==========================================
// Tracking Helpers
// ==========================================

/**
 * Track vocabulary that has been introduced
 */
export function trackVocabularyIntroduced(
  state: FlexibleLessonState,
  words: string[],
): FlexibleLessonState {
  for (const word of words) {
    if (!state.vocabularyIntroduced.includes(word)) {
      state.vocabularyIntroduced.push(word);
    }
  }
  return state;
}

/**
 * Track kanji that has been introduced
 */
export function trackKanjiIntroduced(
  state: FlexibleLessonState,
  characters: string[],
): FlexibleLessonState {
  for (const char of characters) {
    if (!state.kanjiIntroduced.includes(char)) {
      state.kanjiIntroduced.push(char);
    }
  }
  return state;
}

/**
 * Track exercise result
 */
export function trackExerciseResult(
  state: FlexibleLessonState,
  correct: boolean,
): FlexibleLessonState {
  if (correct) {
    state.exerciseResults.correct++;
  } else {
    state.exerciseResults.incorrect++;
  }
  return state;
}

/**
 * Calculate overall lesson score (0-100)
 */
export function calculateLessonScore(state: FlexibleLessonState): number {
  const totalExercises = state.exerciseResults.correct + state.exerciseResults.incorrect;
  if (totalExercises === 0) {
    return 100; // No exercises attempted yet
  }

  const exerciseScore = (state.exerciseResults.correct / totalExercises) * 100;
  const completionScore = getProgressPercentage(state);

  // Weight: 60% exercise performance, 40% completion
  return Math.round(exerciseScore * 0.6 + completionScore * 0.4);
}
