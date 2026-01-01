import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  TelegramUpdate,
  Intent,
  StartLessonIntent,
  AnswerQuestionIntent,
  RequestHintIntent,
  SkipExerciseIntent,
  RequestExplanationIntent,
  ReviewVocabularyIntent,
  SetLessonTimeIntent,
  ChangePaceIntent,
  FreeConversationIntent,
  PracticeTopicIntent,
  StartCatchUpIntent,
  LessonChecklist,
} from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import {
  parseIntent,
  generateActionResponse,
  generateConversationSummary,
  generateLessonResponse,
  generateLessonIntro,
  generateLessonComplete,
  evaluateTeachingAnswer,
  ConversationContext,
} from "../lib/llm.js";
import * as redis from "../lib/redis.js";
import * as lessonEngine from "../lib/lesson-engine.js";
import * as syllabus from "../lib/syllabus.js";
import {
  scheduleDailyLesson,
  deleteSchedule,
} from "../lib/qstash.js";
import {
  generateChecklist,
  advanceChecklist,
  insertClarification,
  isChecklistComplete,
} from "../lib/lesson-checklist.js";

// Register the summarization callback to avoid circular imports
redis.setSummarizationCallback(generateConversationSummary);

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let chatId: number | undefined;

  try {
    const update = req.body as TelegramUpdate;

    if (!update.message) {
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = update;
    chatId = message.chat.id;

    // Check if user is allowed
    const allowedUsers = process.env.ALLOWED_USERS;
    if (allowedUsers) {
      const allowed = allowedUsers.split(",").map((u) => u.trim().toLowerCase());
      const userId = message.from?.id?.toString();
      const username = message.from?.username?.toLowerCase();

      if (!(userId && allowed.includes(userId)) && !(username && allowed.includes(username))) {
        await telegram.sendMessage(chatId, "Sorry, this bot is private.");
        res.status(200).json({ ok: true });
        return;
      }
    }

    // New user setup
    const isNewUser = await redis.registerChat(chatId);
    if (isNewUser) {
      const displayName = message.from?.first_name || "Student";
      await redis.createUserProfile(chatId, displayName);
      await setupDefaultSchedules(chatId);

      await telegram.sendMessage(
        chatId,
        `Welcome! I'm Emi, your Japanese language tutor for the next 30 days! *tail wags*\n\nWe'll learn JLPT N5 together through daily lessons.\n\nSay "start lesson" when you're ready!`,
      );
      res.status(200).json({ ok: true });
      return;
    }

    // Get user input (voice or text)
    let userText: string;

    if (message.voice) {
      await telegram.sendMessage(chatId, "Transcribing...");
      try {
        const filePath = await telegram.getFilePath(message.voice.file_id);
        const audioBuffer = await telegram.downloadFile(filePath);
        userText = await transcribeAudio(audioBuffer);
        await telegram.sendMessage(chatId, `_"${userText}"_`);
      } catch (error) {
        console.error("Transcription error:", error);
        await telegram.sendMessage(chatId, "Sorry, couldn't transcribe. Try again or send text.");
        res.status(200).json({ ok: true });
        return;
      }
    } else if (message.text) {
      userText = message.text;
    } else {
      res.status(200).json({ ok: true });
      return;
    }

    // Handle /debug command
    if (userText.trim().toLowerCase() === "/debug") {
      await handleDebugCommand(chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Get context
    const [conversationData, activeLessonState, activeChecklist] = await Promise.all([
      redis.getConversationData(chatId),
      redis.getActiveLessonState(chatId),
      redis.getLessonChecklist(chatId),
    ]);

    const context: ConversationContext = {
      messages: conversationData.messages,
      summary: conversationData.summary,
    };

    // NEW: Checklist-based lesson flow (takes priority)
    if (activeChecklist) {
      console.log(`[${chatId}] Active checklist for Day ${activeChecklist.dayNumber}, item ${activeChecklist.currentIndex + 1}/${activeChecklist.totalCount}`);
      const response = await handleChecklistLesson(chatId, userText, activeChecklist, context);
      if (response) {
        await redis.addToConversation(chatId, userText, response, {
          dayNumber: activeChecklist.dayNumber,
          phase: "vocabulary_teaching", // Legacy compatibility
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    // LEGACY: During teaching phases, treat any response as acknowledgment to continue
    // This path is kept for backwards compatibility but new lessons use checklists
    if (activeLessonState && isTeachingPhase(activeLessonState.phase)) {
      console.log(`[${chatId}] In teaching phase (${activeLessonState.phase}), advancing lesson`);
      const response = await handleTeachingResponse(chatId, userText, context);
      if (response) {
        await redis.addToConversation(chatId, userText, response, {
          dayNumber: activeLessonState.dayNumber,
          phase: activeLessonState.phase,
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    // Parse intent for non-teaching interactions
    const intent = await parseIntent(userText, conversationData.messages, activeLessonState);

    console.log(`[${chatId}] Intent: ${intent.type}`);
    const response = await handleIntent(chatId, intent, context);

    if (response) {
      const lessonState = await redis.getActiveLessonState(chatId);
      const lessonContext = lessonState
        ? { dayNumber: lessonState.dayNumber, phase: lessonState.phase }
        : undefined;
      await redis.addToConversation(chatId, userText, response, lessonContext);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    if (chatId) {
      try {
        await telegram.sendMessage(chatId, "Something went wrong. Try again?");
      } catch {}
    }
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleIntent(
  chatId: number,
  intent: Intent,
  context: ConversationContext,
): Promise<string | null> {
  switch (intent.type) {
    case "start_lesson":
      return handleStartLesson(chatId, intent, context);
    case "answer_question":
      return handleAnswerQuestion(chatId, intent, context);
    case "request_hint":
      return handleRequestHint(chatId, context);
    case "skip_exercise":
      return handleSkipExercise(chatId, context);
    case "request_explanation":
      return handleRequestExplanation(chatId, intent, context);
    case "pause_lesson":
      return handlePauseLesson(chatId, context);
    case "resume_lesson":
      return handleResumeLesson(chatId, context);
    case "show_progress":
      return handleShowProgress(chatId, context);
    case "show_weak_areas":
      return handleShowWeakAreas(chatId, context);
    case "review_vocabulary":
      return handleReviewVocabulary(chatId, intent, context);
    case "show_lesson_history":
      return handleShowLessonHistory(chatId, context);
    case "set_lesson_time":
      return handleSetLessonTime(chatId, intent, context);
    case "change_pace":
      return handleChangePace(chatId, intent, context);
    case "free_conversation":
      return handleFreeConversation(chatId, intent, context);
    case "practice_topic":
      return handlePracticeTopic(chatId, intent, context);
    case "show_missed_lessons":
      return handleShowMissedLessons(chatId, context);
    case "start_catch_up":
      return handleStartCatchUp(chatId, intent, context);
    case "conversation":
      const response = await generateActionResponse(
        { type: "conversation", message: intent.message },
        context,
      );
      await telegram.sendMessage(chatId, response);
      return response;
    default:
      return null;
  }
}

// ==========================================
// Teaching Phase Helpers
// ==========================================

function isTeachingPhase(phase: string): boolean {
  return ["vocabulary_teaching", "grammar_teaching", "kanji_teaching"].includes(phase);
}

// ==========================================
// Checklist-Based Lesson Flow (New Architecture)
// ==========================================

async function handleChecklistLesson(
  chatId: number,
  userText: string,
  checklist: LessonChecklist,
  context: ConversationContext,
): Promise<string> {
  // Check if lesson is already complete
  if (isChecklistComplete(checklist)) {
    const profile = await redis.getUserProfile(chatId);
    const response = await generateLessonComplete(checklist, profile?.currentStreak || 1, context);
    await telegram.sendMessage(chatId, response);

    // Clean up checklist
    await redis.clearLessonChecklist(chatId);

    // Update user progress
    if (profile) {
      await redis.updateStreak(chatId);
      await redis.advanceToNextDay(chatId);
    }

    return response;
  }

  // Generate LLM response with checklist context
  const llmResponse = await generateLessonResponse(
    checklist,
    context.messages,
    userText,
  );

  // Handle checklist action
  let updatedChecklist = checklist;

  switch (llmResponse.checklistAction) {
    case "complete":
      // Mark current item complete and advance
      const result = advanceChecklist(updatedChecklist);
      updatedChecklist = result.checklist;

      if (result.isComplete) {
        // Lesson complete!
        await redis.saveLessonChecklist(updatedChecklist);
        await telegram.sendMessage(chatId, llmResponse.message);

        // Generate completion message
        const profile = await redis.getUserProfile(chatId);
        const completionMsg = await generateLessonComplete(
          updatedChecklist,
          profile?.currentStreak || 1,
          context,
        );
        await telegram.sendMessage(chatId, completionMsg);

        // Clean up
        await redis.clearLessonChecklist(chatId);
        await redis.clearActiveLessonState(chatId);

        // Update progress
        if (profile) {
          await redis.updateStreak(chatId);
          await redis.advanceToNextDay(chatId);
        }

        return llmResponse.message + "\n\n" + completionMsg;
      }
      break;

    case "insert":
      // Insert clarification item
      if (llmResponse.insertItem?.content) {
        updatedChecklist = insertClarification(
          updatedChecklist,
          llmResponse.insertItem.content,
        );
      }
      break;

    case "none":
    default:
      // Stay on current item, no changes to checklist
      break;
  }

  // Save updated checklist
  await redis.saveLessonChecklist(updatedChecklist);

  // Send response to user
  await telegram.sendMessage(chatId, llmResponse.message);

  return llmResponse.message;
}

async function handleTeachingResponse(
  chatId: number,
  userText: string,
  context: ConversationContext,
): Promise<string> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) return "No active lesson.";

  const dayContent = await syllabus.getSyllabusDay(state.dayNumber);
  if (!dayContent) return "Could not load lesson content.";

  // Get the current teaching item
  const result = await lessonEngine.getCurrentTeachingItem(chatId);

  // If no teaching item (all done), advance to next phase
  if (!result.data?.vocabularyItem && !result.data?.grammarPattern && !result.data?.kanjiItem) {
    await continueLesson(chatId, context);
    return "Teaching phase complete - advanced";
  }

  // Get the Japanese word/phrase to check against
  let expectedJapanese = "";
  if (result.data?.vocabularyItem) {
    expectedJapanese = result.data.vocabularyItem.japanese;
  } else if (result.data?.grammarPattern) {
    expectedJapanese = result.data.grammarPattern.pattern;
  } else if (result.data?.kanjiItem) {
    expectedJapanese = result.data.kanjiItem.character;
  }

  // Check for simple acknowledgments first
  const normalizedInput = userText.toLowerCase().trim();
  const isAcknowledgment = ["ok", "okay", "got it", "yes", "hai", "はい", "next", "continue", "understood", "うん"].some(
    ack => normalizedInput === ack || normalizedInput === ack + "."
  );

  if (isAcknowledgment) {
    // Just acknowledging, move on to next item
    await lessonEngine.advanceToNextItem(chatId);
    await continueLesson(chatId, context);
    return "Acknowledged";
  }

  // Simple evaluation: does the user's answer contain/match the expected Japanese?
  const isCorrect = await evaluateTeachingAnswer(userText, expectedJapanese);

  if (isCorrect) {
    // Correct! Advance to next item (the next prompt will acknowledge them)
    await lessonEngine.advanceToNextItem(chatId);
    await continueLesson(chatId, context);
    return "Correct - advanced to next item";
  } else {
    // Incorrect - just tell them what we're practicing and ask to try again
    // Keep it simple - don't generate a long LLM response
    const response = `Not quite! We're practicing: **${expectedJapanese}**\nTry saying/typing it!`;
    await telegram.sendMessage(chatId, response);
    return response;
  }
}

// ==========================================
// Lesson Intent Handlers
// ==========================================

async function handleStartLesson(
  chatId: number,
  intent: StartLessonIntent,
  context: ConversationContext,
): Promise<string> {
  const profile = await redis.getUserProfile(chatId);
  if (!profile) {
    const response = "I couldn't find your profile. Please try again.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Check if already has an active checklist
  const existingChecklist = await redis.getLessonChecklist(chatId);
  if (existingChecklist) {
    // Continue where they left off with existing checklist
    const response = `You're already in Day ${existingChecklist.dayNumber}. Let's continue where we left off!`;
    await telegram.sendMessage(chatId, response);

    // Send the first teaching prompt to resume
    const resumeResponse = await handleChecklistLesson(chatId, "continue", existingChecklist, context);
    return response + "\n\n" + resumeResponse;
  }

  // Check for legacy active lesson state
  const existingState = await redis.getActiveLessonState(chatId);
  if (existingState) {
    // Clear legacy state and start fresh with checklist
    await redis.clearActiveLessonState(chatId);
  }

  const dayNumber = intent.dayNumber || profile.currentDay;

  // Load syllabus to verify day exists
  const dayContent = await syllabus.getSyllabusDay(dayNumber);
  if (!dayContent) {
    const response = `Day ${dayNumber} content isn't available yet. Let's try Day 1!`;
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Generate checklist for this lesson
  const checklist = await generateChecklist(chatId, dayNumber);
  if (!checklist) {
    const response = "I couldn't load the lesson content. Please try again.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Save checklist to Redis
  await redis.saveLessonChecklist(checklist);

  // Also start legacy lesson progress for tracking
  await redis.startLesson(chatId, dayNumber);

  // Generate intro message
  const introResponse = await generateLessonIntro(checklist, context);
  await telegram.sendMessage(chatId, introResponse);

  // Now start the first teaching item by generating the first LLM response
  const firstItemResponse = await generateLessonResponse(
    checklist,
    context.messages,
    "Let's begin!", // Synthetic first message to kick off teaching
  );

  // Handle any checklist action from the first response
  if (firstItemResponse.checklistAction === "complete") {
    const result = advanceChecklist(checklist);
    await redis.saveLessonChecklist(result.checklist);
  }

  await telegram.sendMessage(chatId, firstItemResponse.message);

  return introResponse + "\n\n" + firstItemResponse.message;
}

async function handleAnswerQuestion(
  chatId: number,
  intent: AnswerQuestionIntent,
  context: ConversationContext,
): Promise<string> {
  const activeState = await redis.getActiveLessonState(chatId);
  if (!activeState) {
    const response = "You're not in an active lesson. Say 'start lesson' to begin.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  if (!activeState.currentExercise) {
    // Not in an exercise, treat as acknowledgment and continue
    return continueLesson(chatId, context);
  }

  // Evaluate the answer
  const result = await lessonEngine.evaluateAnswer(chatId, intent.answer);

  let response: string;
  if (result.isCorrect) {
    response = await generateActionResponse(
      {
        type: "exercise_correct",
        item: activeState.currentExercise.itemId,
        streak: activeState.correctThisSession + 1,
      },
      context,
    );
  } else if (result.isPartiallyCorrect) {
    response = await generateActionResponse(
      { type: "conversation", message: "Almost there! Try again or say 'hint' for help." },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  } else {
    response = await generateActionResponse(
      {
        type: "exercise_incorrect",
        userAnswer: intent.answer,
        correctAnswer: result.correctAnswer,
        explanation: result.feedback,
      },
      context,
    );
  }

  await telegram.sendMessage(chatId, response);

  // Continue to next item if we should advance
  if (result.shouldAdvance) {
    await continueLesson(chatId, context);
  }

  return response;
}

async function handleRequestHint(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const hint = await lessonEngine.getHint(chatId);

  if (!hint) {
    const response = "There's no active exercise to give a hint for.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const state = await redis.getActiveLessonState(chatId);
  const hintsRemaining = state?.currentExercise
    ? state.currentExercise.hints.length - state.currentExercise.hintsGiven
    : 0;

  const response = await generateActionResponse(
    { type: "hint_given", hint, hintsRemaining },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleSkipExercise(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const activeState = await redis.getActiveLessonState(chatId);
  if (!activeState) {
    const response = "You're not in an active lesson.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  await lessonEngine.skipExercise(chatId);

  const response = await generateActionResponse(
    { type: "conversation", message: "Skipping this one. We'll review it later." },
    context,
  );
  await telegram.sendMessage(chatId, response);

  // Continue to next
  await continueLesson(chatId, context);

  return response;
}

async function handleRequestExplanation(
  chatId: number,
  intent: RequestExplanationIntent,
  context: ConversationContext,
): Promise<string> {
  const activeState = await redis.getActiveLessonState(chatId);

  // If in a lesson, explain the current item
  if (activeState && activeState.currentExercise) {
    const exercise = activeState.currentExercise;
    const dayContent = await syllabus.getSyllabusDay(activeState.dayNumber);

    if (dayContent) {
      let explanation = "";
      if (exercise.itemType === "vocabulary") {
        const item = dayContent.vocabulary.find((v) => v.id === exercise.itemId);
        if (item) {
          explanation = `**${item.japanese}** (${item.reading}) means "${item.meaning}". It's a ${item.partOfSpeech}.`;
          if (item.exampleSentence) {
            explanation += `\n\nExample: ${item.exampleSentence}\n(${item.exampleMeaning})`;
          }
        }
      } else if (exercise.itemType === "grammar") {
        const item = dayContent.grammar.find((g) => g.id === exercise.itemId);
        if (item) {
          explanation = `**${item.pattern}** - ${item.meaning}\n\nFormation: ${item.formation}`;
          if (item.examples.length > 0) {
            explanation += `\n\nExample: ${item.examples[0].japanese}\n(${item.examples[0].meaning})`;
          }
        }
      } else if (exercise.itemType === "kanji") {
        const item = dayContent.kanji.find((k) => k.id === exercise.itemId);
        if (item) {
          explanation = `**${item.character}** - ${item.meanings.join(", ")}\n`;
          explanation += `On'yomi: ${item.readings.onyomi.join(", ")}\n`;
          explanation += `Kun'yomi: ${item.readings.kunyomi.join(", ")}`;
        }
      }

      if (explanation) {
        const response = await generateActionResponse(
          { type: "conversation", message: explanation },
          context,
        );
        await telegram.sendMessage(chatId, response);
        return response;
      }
    }
  }

  // General explanation request
  const response = await generateActionResponse(
    { type: "conversation", message: intent.topic ? `Let me explain about ${intent.topic}...` : "What would you like me to explain?" },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handlePauseLesson(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const activeState = await redis.getActiveLessonState(chatId);
  if (!activeState) {
    const response = "You're not in an active lesson.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const response = await generateActionResponse(
    {
      type: "lesson_paused",
      dayNumber: activeState.dayNumber,
      progress: `${activeState.phase} phase`,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleResumeLesson(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const activeState = await redis.getActiveLessonState(chatId);
  if (!activeState) {
    const response = "No paused lesson found. Say 'start lesson' to begin a new one.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const response = await generateActionResponse(
    {
      type: "lesson_resumed",
      dayNumber: activeState.dayNumber,
      phase: activeState.phase,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);

  // Continue the lesson
  await continueLesson(chatId, context);

  return response;
}

// ==========================================
// Lesson Flow Helpers
// ==========================================

async function continueLesson(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) {
    return "No active lesson.";
  }

  // Route based on current phase
  switch (state.phase) {
    case "intro":
      // Advance to vocabulary teaching
      await lessonEngine.advancePhase(chatId);
      return advanceLessonPhase(chatId, context);

    case "vocabulary_teaching":
    case "grammar_teaching":
    case "kanji_teaching":
      return showNextTeachingItem(chatId, context);

    case "vocabulary_practice":
    case "grammar_practice":
    case "kanji_practice":
    case "review":
    case "assessment":
      return showNextExercise(chatId, context);

    case "complete":
      const profile = await redis.getUserProfile(chatId);
      const response = await generateActionResponse(
        {
          type: "lesson_complete",
          dayNumber: state.dayNumber,
          score: 100,
          streak: profile?.currentStreak || 1,
        },
        context,
      );
      await telegram.sendMessage(chatId, response);
      return response;

    default:
      return advanceLessonPhase(chatId, context);
  }
}

async function advanceLessonPhase(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const state = await redis.getActiveLessonState(chatId);
  if (!state) return "No active lesson.";

  const dayContent = await syllabus.getSyllabusDay(state.dayNumber);
  if (!dayContent) return "Could not load lesson content.";

  // Check if current phase is complete
  const result = await lessonEngine.advancePhase(chatId);

  // Route to appropriate handler
  return continueLesson(chatId, context);
}

async function showNextTeachingItem(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const result = await lessonEngine.getCurrentTeachingItem(chatId);

  if (result.data?.vocabularyItem) {
    const item = result.data.vocabularyItem;
    const response = await generateActionResponse(
      {
        type: "teaching_vocabulary",
        item,
        index: result.data.index!,
        total: result.data.total!,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    // Wait for user response - handleTeachingResponse will advance
    return response;
  }

  if (result.data?.grammarPattern) {
    const item = result.data.grammarPattern;
    const response = await generateActionResponse(
      {
        type: "teaching_grammar",
        item,
        index: result.data.index!,
        total: result.data.total!,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    // Wait for user response - handleTeachingResponse will advance
    return response;
  }

  if (result.data?.kanjiItem) {
    const item = result.data.kanjiItem;
    const response = await generateActionResponse(
      {
        type: "teaching_kanji",
        item,
        index: result.data.index!,
        total: result.data.total!,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    // Wait for user response - handleTeachingResponse will advance
    return response;
  }

  // No more items, advance phase
  return continueLesson(chatId, context);
}

async function showNextExercise(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const result = await lessonEngine.generateExercise(chatId);

  if (result.phase === "complete") {
    const profile = await redis.getUserProfile(chatId);
    const response = await generateActionResponse(
      {
        type: "lesson_complete",
        dayNumber: result.data?.score ? 0 : 0,
        score: result.data?.score || 100,
        streak: profile?.currentStreak || 1,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  if (result.phase === "review" && result.data?.passed === false) {
    const response = await generateActionResponse(
      {
        type: "conversation",
        message: `You scored ${result.data.score}%. Let's review the items you struggled with.`,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);

    await showNextExercise(chatId, context);

    return response;
  }

  if (result.data?.exercise) {
    const response = await generateActionResponse(
      { type: "exercise_prompt", exercise: result.data.exercise },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Advance phase
  return continueLesson(chatId, context);
}

// ==========================================
// Progress Intent Handlers
// ==========================================

async function handleShowProgress(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const profile = await redis.getUserProfile(chatId);
  if (!profile) {
    const response = "I couldn't find your profile.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const masteredCounts = await redis.getMasteredItemCount(chatId);

  const response = await generateActionResponse(
    {
      type: "progress_summary",
      daysCompleted: profile.totalLessonsCompleted,
      currentStreak: profile.currentStreak,
      vocabMastered: masteredCounts.vocabulary,
      grammarMastered: masteredCounts.grammar,
      kanjiMastered: masteredCounts.kanji,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleShowWeakAreas(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const weakAreas = await redis.getWeakAreas(chatId);

  if (weakAreas.length === 0) {
    const response = await generateActionResponse(
      { type: "conversation", message: "You don't have any weak areas yet. Keep practicing!" },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const areas = weakAreas.slice(0, 5).map((w) => ({
    item: w.itemId,
    type: w.itemType,
    errorCount: w.reviewCount,
  }));

  const response = await generateActionResponse(
    { type: "weak_areas", areas },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleReviewVocabulary(
  chatId: number,
  intent: ReviewVocabularyIntent,
  context: ConversationContext,
): Promise<string> {
  const response = await generateActionResponse(
    { type: "conversation", message: "Let's review some vocabulary!" },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleShowLessonHistory(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const completedLessons = await redis.getCompletedLessons(chatId);

  if (completedLessons.length === 0) {
    const response = await generateActionResponse(
      { type: "conversation", message: "You haven't completed any lessons yet. Say 'start lesson' to begin!" },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const historyText = completedLessons
    .map((l) => `Day ${l.dayNumber}: ${l.overallScore}% (${l.actualCompletedDate})`)
    .join("\n");

  const response = await generateActionResponse(
    { type: "conversation", message: `Your lesson history:\n\n${historyText}` },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

// ==========================================
// Settings Intent Handlers
// ==========================================

async function handleSetLessonTime(
  chatId: number,
  intent: SetLessonTimeIntent,
  context: ConversationContext,
): Promise<string> {
  const profile = await redis.setLessonTime(chatId, intent.hour, intent.minute);
  if (!profile) {
    const response = "I couldn't update your lesson time.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  if (profile.lessonScheduleId) {
    await deleteSchedule(profile.lessonScheduleId);
  }

  const cronExpression = `${intent.minute} ${intent.hour} * * *`;
  const scheduleId = await scheduleDailyLesson(chatId, cronExpression);
  profile.lessonScheduleId = scheduleId;
  await redis.updateUserProfile(profile);

  const response = await generateActionResponse(
    { type: "lesson_time_set", hour: intent.hour, minute: intent.minute },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleChangePace(
  chatId: number,
  intent: ChangePaceIntent,
  context: ConversationContext,
): Promise<string> {
  const response = await generateActionResponse(
    { type: "conversation", message: `Pace changed to ${intent.pace}.` },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

// ==========================================
// Free Practice Intent Handlers
// ==========================================

async function handleFreeConversation(
  chatId: number,
  intent: FreeConversationIntent,
  context: ConversationContext,
): Promise<string> {
  const response = await generateActionResponse(
    {
      type: "free_conversation",
      userMessage: intent.message,
      inJapanese: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(intent.message),
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handlePracticeTopic(
  chatId: number,
  intent: PracticeTopicIntent,
  context: ConversationContext,
): Promise<string> {
  const response = await generateActionResponse(
    { type: "conversation", message: `Let's practice ${intent.topic}!` },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

// ==========================================
// Catch-up Intent Handlers
// ==========================================

async function handleShowMissedLessons(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const missedDays = await redis.getMissedLessons(chatId);

  if (missedDays.length === 0) {
    const response = await generateActionResponse(
      { type: "conversation", message: "You're all caught up! No missed lessons." },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const response = await generateActionResponse(
    { type: "missed_lessons", days: missedDays, total: missedDays.length },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleStartCatchUp(
  chatId: number,
  intent: StartCatchUpIntent,
  context: ConversationContext,
): Promise<string> {
  return handleStartLesson(
    chatId,
    { type: "start_lesson", dayNumber: intent.dayNumber },
    context,
  );
}

// ==========================================
// Debug & Setup
// ==========================================

async function handleDebugCommand(chatId: number): Promise<void> {
  const [profile, activeState, lessonContext, checklist] = await Promise.all([
    redis.getUserProfile(chatId),
    redis.getActiveLessonState(chatId),
    redis.getLessonContext(chatId),
    redis.getLessonChecklist(chatId),
  ]);

  const debugInfo = {
    profile: profile
      ? {
          displayName: profile.displayName,
          currentDay: profile.currentDay,
          streak: profile.currentStreak,
          lessonsCompleted: profile.totalLessonsCompleted,
        }
      : null,
    checklist: checklist
      ? {
          day: checklist.dayNumber,
          title: checklist.title,
          currentIndex: checklist.currentIndex,
          currentItem: checklist.items[checklist.currentIndex]?.displayText || "complete",
          progress: `${checklist.completedCount}/${checklist.totalCount}`,
        }
      : null,
    legacyActiveLesson: activeState
      ? {
          day: activeState.dayNumber,
          phase: activeState.phase,
          itemIndex: activeState.currentItemIndex,
          correct: activeState.correctThisSession,
          incorrect: activeState.incorrectThisSession,
          hasExercise: !!activeState.currentExercise,
        }
      : null,
    weakAreas: lessonContext?.weakAreas.length || 0,
    masteredCounts: lessonContext?.masteredCounts || null,
  };

  await telegram.sendMessage(
    chatId,
    `Debug:\n\`\`\`json\n${JSON.stringify(debugInfo, null, 2)}\n\`\`\``,
  );
}

async function setupDefaultSchedules(chatId: number): Promise<void> {
  try {
    const cronExpression = `0 9 * * *`;
    const scheduleId = await scheduleDailyLesson(chatId, cronExpression);

    const profile = await redis.getUserProfile(chatId);
    if (profile) {
      profile.lessonScheduleId = scheduleId;
      await redis.updateUserProfile(profile);
    }
  } catch (error) {
    console.error(`Failed to set up schedule for ${chatId}:`, error);
  }
}
