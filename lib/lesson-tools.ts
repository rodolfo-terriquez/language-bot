/**
 * Lesson Tools for LLM
 *
 * These tools are provided to the LLM during lesson teaching.
 * The LLM uses them to track progress, mark vocabulary correct/incorrect,
 * and update the lesson state - all while teaching naturally.
 */

import * as redis from "./redis.js";
import { markVocabularyCorrect } from "./vocabulary.js";
import type { StoredLessonState } from "./redis.js";

// ==========================================
// Tool Definitions for OpenAI Function Calling
// ==========================================

export const lessonToolDefinitions = [
  {
    type: "function" as const,
    function: {
      name: "mark_vocab_correct",
      description:
        "Mark vocabulary words as correctly answered/recalled by the student. Call this when the student demonstrates understanding of a word.",
      parameters: {
        type: "object",
        properties: {
          words: {
            type: "array",
            items: { type: "string" },
            description: "List of vocabulary words (in Japanese) that were answered correctly",
          },
        },
        required: ["words"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_progress",
      description:
        "Update which section of the lesson the student is currently in. Call this when transitioning between lesson components.",
      parameters: {
        type: "object",
        properties: {
          component: {
            type: "string",
            enum: [
              "grammar",
              "vocabulary",
              "kanji",
              "reading",
              "dialogue",
              "exercises",
              "complete",
            ],
            description: "The lesson component the student is now in",
          },
        },
        required: ["component"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "record_exercise_result",
      description:
        "Record the result of a practice exercise. Call this after evaluating a student's answer to an exercise.",
      parameters: {
        type: "object",
        properties: {
          correct: {
            type: "boolean",
            description: "Whether the student's answer was correct (or close enough)",
          },
          exerciseId: {
            type: "string",
            description: "The ID of the exercise that was answered",
          },
        },
        required: ["correct"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "complete_lesson",
      description:
        "Mark the lesson as complete. Call this when the student has finished all sections and exercises.",
      parameters: {
        type: "object",
        properties: {
          exerciseScore: {
            type: "number",
            description: "The student's score on exercises (0-100)",
          },
        },
        required: ["exerciseScore"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "note_observation",
      description:
        "Record an observation about the student's learning. Use this to note areas they struggle with, topics they're interested in, or their learning preferences.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The observation to record",
          },
          type: {
            type: "string",
            enum: ["struggling", "preference", "strength"],
            description: "The type of observation",
          },
        },
        required: ["note", "type"],
      },
    },
  },
];

// ==========================================
// Tool Execution Functions
// ==========================================

export interface ToolCallResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

/**
 * Execute a tool call from the LLM
 */
export async function executeToolCall(
  chatId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  console.log(`[lesson-tools] Executing tool: ${toolName}`, args);

  switch (toolName) {
    case "mark_vocab_correct":
      return await handleMarkVocabCorrect(chatId, args.words as string[]);

    case "update_progress":
      return await handleUpdateProgress(
        chatId,
        args.component as StoredLessonState["currentComponent"],
      );

    case "record_exercise_result":
      return await handleRecordExerciseResult(
        chatId,
        args.correct as boolean,
        args.exerciseId as string | undefined,
      );

    case "complete_lesson":
      return await handleCompleteLesson(chatId, args.exerciseScore as number);

    case "note_observation":
      return await handleNoteObservation(chatId, args.note as string, args.type as string);

    default:
      console.warn(`[lesson-tools] Unknown tool: ${toolName}`);
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}

/**
 * Mark vocabulary words as correctly answered
 */
async function handleMarkVocabCorrect(chatId: number, words: string[]): Promise<ToolCallResult> {
  if (!words || words.length === 0) {
    return { success: false, message: "No words provided" };
  }

  try {
    await markVocabularyCorrect(chatId, words);

    // Also update lesson state
    const state = await redis.getLessonState(chatId);
    if (state) {
      for (const word of words) {
        if (!state.vocabCorrect.includes(word)) {
          state.vocabCorrect.push(word);
        }
      }
      await redis.saveLessonState(state);
    }

    return {
      success: true,
      message: `Marked ${words.length} word(s) as correct`,
      data: { words },
    };
  } catch (error) {
    console.error("[lesson-tools] Error marking vocab correct:", error);
    return { success: false, message: "Failed to mark vocabulary correct" };
  }
}

/**
 * Update the current lesson component
 */
async function handleUpdateProgress(
  chatId: number,
  component: StoredLessonState["currentComponent"],
): Promise<ToolCallResult> {
  try {
    const state = await redis.getLessonState(chatId);
    if (!state) {
      return { success: false, message: "No active lesson state" };
    }

    state.currentComponent = component;
    await redis.saveLessonState(state);

    return {
      success: true,
      message: `Updated progress to: ${component}`,
      data: { component },
    };
  } catch (error) {
    console.error("[lesson-tools] Error updating progress:", error);
    return { success: false, message: "Failed to update progress" };
  }
}

/**
 * Record an exercise result
 */
async function handleRecordExerciseResult(
  chatId: number,
  correct: boolean,
  exerciseId?: string,
): Promise<ToolCallResult> {
  try {
    const state = await redis.getLessonState(chatId);
    if (!state) {
      return { success: false, message: "No active lesson state" };
    }

    if (correct) {
      state.exerciseResults.correct++;
    } else {
      state.exerciseResults.incorrect++;
    }
    await redis.saveLessonState(state);

    return {
      success: true,
      message: `Recorded ${correct ? "correct" : "incorrect"} answer`,
      data: {
        correct,
        exerciseId,
        totalCorrect: state.exerciseResults.correct,
        totalIncorrect: state.exerciseResults.incorrect,
      },
    };
  } catch (error) {
    console.error("[lesson-tools] Error recording exercise result:", error);
    return { success: false, message: "Failed to record exercise result" };
  }
}

/**
 * Complete the current lesson
 */
async function handleCompleteLesson(
  chatId: number,
  exerciseScore: number,
): Promise<ToolCallResult> {
  try {
    const state = await redis.getLessonState(chatId);
    if (!state) {
      return { success: false, message: "No active lesson state" };
    }

    // Calculate time spent
    const timeSpentMinutes = Math.round((Date.now() - state.startedAt) / 60000);

    // Mark lesson as complete in Tae Kim progress
    await redis.markTaeKimLessonComplete(
      chatId,
      state.lessonNumber,
      exerciseScore,
      timeSpentMinutes,
    );

    // Update lesson state to complete
    state.currentComponent = "complete";
    await redis.saveLessonState(state);

    // Clear the lesson state after a delay (or keep for review)
    // For now, we'll clear it immediately
    await redis.clearLessonState(chatId);

    return {
      success: true,
      message: `Lesson ${state.lessonNumber} completed!`,
      data: {
        lessonNumber: state.lessonNumber,
        exerciseScore,
        timeSpentMinutes,
        vocabCorrectCount: state.vocabCorrect.length,
      },
    };
  } catch (error) {
    console.error("[lesson-tools] Error completing lesson:", error);
    return { success: false, message: "Failed to complete lesson" };
  }
}

/**
 * Record an observation about the student
 */
async function handleNoteObservation(
  chatId: number,
  note: string,
  type: string,
): Promise<ToolCallResult> {
  try {
    const profile = await redis.getUserProfile(chatId);
    if (!profile) {
      return { success: false, message: "User profile not found" };
    }

    // Initialize arrays if they don't exist (for backwards compatibility)
    if (!profile.strugglingAreas) profile.strugglingAreas = [];
    if (!profile.learningNotes) profile.learningNotes = [];

    // Add to user profile based on type
    switch (type) {
      case "struggling":
        // Add to struggling areas if not already there
        if (!profile.strugglingAreas.includes(note)) {
          profile.strugglingAreas.push(note);
          // Keep only last 10 struggling areas
          if (profile.strugglingAreas.length > 10) {
            profile.strugglingAreas = profile.strugglingAreas.slice(-10);
          }
        }
        break;
      case "strength":
        // Remove from struggling areas if they've mastered it
        profile.strugglingAreas = profile.strugglingAreas.filter((a) => a !== note);
        break;
      case "preference":
      default:
        // Add to learning notes
        const timestampedNote = `[${new Date().toISOString().split("T")[0]}] ${note}`;
        profile.learningNotes.push(timestampedNote);
        // Keep only last 20 notes
        if (profile.learningNotes.length > 20) {
          profile.learningNotes = profile.learningNotes.slice(-20);
        }
        break;
    }

    await redis.updateUserProfile(profile);

    console.log(`[lesson-tools] Observation for user ${chatId}: [${type}] ${note}`);

    return {
      success: true,
      message: `Recorded observation: ${type}`,
      data: { note, type },
    };
  } catch (error) {
    console.error("[lesson-tools] Error recording observation:", error);
    return { success: false, message: "Failed to record observation" };
  }
}

// ==========================================
// Helper to format tools for system prompt
// ==========================================

/**
 * Get a human-readable description of available tools for the system prompt
 */
export function getToolsDescription(): string {
  return `
You have access to the following tools to track the student's progress during the lesson:

1. **mark_vocab_correct(words)** - Call when the student correctly recalls/uses vocabulary words
2. **update_progress(component)** - Call when moving to a new section (grammar → vocabulary → kanji → reading → dialogue → exercises → complete)
3. **record_exercise_result(correct, exerciseId)** - Call after evaluating each exercise answer
4. **complete_lesson(exerciseScore)** - Call when the lesson is finished to save progress
5. **note_observation(note, type)** - Call to record observations about the student's learning (struggling areas, preferences, strengths)

Use these tools naturally as you teach - don't announce when you're using them, just use them in the background to track progress.
`.trim();
}
