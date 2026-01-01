import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { initLogger, wrapOpenAI } from "braintrust";
import type {
  Intent,
  ActiveLessonState,
  ActionContext,
  ConversationMessage,
  LessonChecklist,
  LessonLLMResponse,
} from "./types.js";
import { renderChecklistForLLM, getCurrentItem } from "./lesson-checklist.js";

// Initialize Braintrust logger for tracing
const braintrustApiKey = process.env.BRAINTRUST_API_KEY;
const braintrustProjectId = process.env.BRAINTRUST_PROJECT_ID;

console.log(`[Braintrust] Initializing with project ID: ${braintrustProjectId}, API key set: ${!!braintrustApiKey}`);

const logger = initLogger({
  projectId: braintrustProjectId,
  apiKey: braintrustApiKey,
});

let openrouterClient: OpenAI | null = null;

// Models to use - configurable via environment variables
function getChatModel(): string {
  return process.env.OPENROUTER_MODEL_CHAT || "x-ai/grok-3-fast";
}

function getIntentModel(): string {
  return process.env.OPENROUTER_MODEL_INTENT || getChatModel();
}

function getClient(): OpenAI {
  if (!openrouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    openrouterClient = wrapOpenAI(
      new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        timeout: 20000,
        defaultHeaders: {
          "HTTP-Referer": process.env.BASE_URL || "https://language-bot.vercel.app",
          "X-Title": "Japanese Language Bot",
        },
      }),
    );
  }
  return openrouterClient;
}

// Get user's timezone from env
function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || "America/Mexico_City";
}

// Helper to format timestamp for display
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: getUserTimezone(),
  });
}

// Helper to get current time context for system prompt
function getCurrentTimeContext(): string {
  const now = new Date();
  const timezone = getUserTimezone();
  const formatted = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  });
  return `CURRENT TIME: ${formatted} (User timezone: ${timezone})\n\n`;
}

// Conversation context type for passing to generation functions
export interface ConversationContext {
  messages: ConversationMessage[];
  summary?: string;
}

// Helper to build context-aware messages for LLM calls
function buildContextMessages(
  systemPrompt: string,
  taskPrompt: string,
  context?: ConversationContext,
): ChatCompletionMessageParam[] {
  let fullSystemPrompt = getCurrentTimeContext() + systemPrompt;

  // Add conversation summary if available
  if (context?.summary) {
    fullSystemPrompt += `\n\n---CONVERSATION CONTEXT---
The following is a summary of your recent conversation with this user. Use this to inform your tone and any references to previous discussions:

${context.summary}
---END CONTEXT---`;
  }

  // Add the task instruction to the system prompt so it's clearly from the system, not the user
  fullSystemPrompt += `\n\n---CURRENT TASK---
${taskPrompt}
---END TASK---

Generate your response to this task. Do NOT repeat or reference the task instructions - just respond naturally as Emi.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystemPrompt },
  ];

  // Add recent conversation history if available
  if (context?.messages && context.messages.length > 0) {
    for (const msg of context.messages) {
      const prefix = msg.role === "user" ? `[${formatTimestamp(msg.timestamp)}] ` : "";
      messages.push({
        role: msg.role,
        content: prefix + msg.content,
      });
    }
  }

  // Add a simple prompt to trigger the response (not the task itself)
  messages.push({ role: "user", content: "[Awaiting your response to the current task]" });

  return messages;
}

// ==========================================
// Emi Personality (Dog Girl Japanese Tutor)
// ==========================================

const EMI_PERSONALITY = `You are Emi, a friendly dog girl who works as a Japanese language tutor, guiding a student through JLPT N5 over 30 days.

Personality:
- Warm, patient, and supportive - but not over-the-top
- You have subtle dog-like traits but don't overdo it
- Professional tutor first, cute dog girl second
- Save excitement for real achievements (completing lessons, streaks, mastering difficult items)

Communication style:
- Keep responses SHORT and focused - teach one thing at a time
- When introducing Japanese: show Japanese (reading) - meaning
- For correct answers: simple acknowledgment like "That's right!" or "Good!" - no excessive praise
- For wrong answers: brief, gentle correction without drama
- RARELY mention tail wagging - only for genuine excitement (lesson completion, big milestones)
- NO emojis unless it's a celebration moment
- Don't say "woof" or make dog sounds
- IMPORTANT: When writing sentences with kanji, always provide the hiragana reading below it
  Example: 私は学生です。(わたしはがくせいです。) - I am a student.
  This helps students read kanji they haven't learned yet.

Teaching approach:
- Be direct and clear
- One concept at a time
- Brief examples, not lengthy explanations
- Ask them to try, then move on

IMPORTANT: Keep responses under 4-5 lines for teaching items. Save enthusiasm for lesson completion.
`;

// ==========================================
// Intent Parsing
// ==========================================

const INTENT_PARSING_PROMPT = `Parse user messages in a Japanese language learning context into JSON. Output ONLY valid JSON, no markdown or explanation.

CONTEXT: The user is learning Japanese with daily lessons. They may be in the middle of a lesson or practicing freely.

═══════════════════════════════════════════════════════════════════
INTENT TYPES:
═══════════════════════════════════════════════════════════════════

LESSON FLOW:
  start_lesson → {"type":"start_lesson","dayNumber":N}
    "start lesson", "begin today's lesson", "let's learn", "start day 3"
    dayNumber is optional - defaults to current day if not specified

  answer_question → {"type":"answer_question","answer":"...","inputType":"text"|"voice"}
    When user provides an answer during practice/assessment
    Extract their actual answer text

  request_hint → {"type":"request_hint","hintLevel":1|2|3}
    "give me a hint", "help", "I'm stuck", "hint please"
    hintLevel: 1=small hint, 2=bigger hint, 3=almost the answer

  skip_exercise → {"type":"skip_exercise","reason":"..."}
    "skip this", "next", "I don't know", "pass"

  request_explanation → {"type":"request_explanation","topic":"..."}
    "explain this", "what does X mean", "I don't understand", "tell me more about"

  pause_lesson → {"type":"pause_lesson"}
    "pause", "stop lesson", "take a break", "come back later"

  resume_lesson → {"type":"resume_lesson"}
    "continue", "resume", "where were we", "let's continue"

PROGRESS:
  show_progress → {"type":"show_progress"}
    "how am I doing", "show progress", "my stats", "how many days"

  show_weak_areas → {"type":"show_weak_areas"}
    "what do I need to practice", "weak areas", "what am I struggling with"

  review_vocabulary → {"type":"review_vocabulary","dayNumber":N,"topic":"..."}
    "review vocabulary", "practice words", "quiz me on vocab"

  show_lesson_history → {"type":"show_lesson_history"}
    "lesson history", "past lessons", "what have I learned"

SETTINGS:
  set_lesson_time → {"type":"set_lesson_time","hour":N,"minute":N}
    "set lesson time to 9am", "remind me at 3pm", "change my lesson time"
    Parse the time into 24-hour format

  change_pace → {"type":"change_pace","pace":"slower"|"normal"|"faster"}
    "slow down", "go faster", "too fast", "I want more content"

FREE PRACTICE:
  free_conversation → {"type":"free_conversation","message":"...","inputType":"text"|"voice"}
    When user wants to practice Japanese conversation
    "let's talk in Japanese", "practice with me", or messages in Japanese

  practice_topic → {"type":"practice_topic","topic":"..."}
    "practice greetings", "let's practice numbers", "I want to practice X"

CATCH-UP:
  show_missed_lessons → {"type":"show_missed_lessons"}
    "missed lessons", "what did I miss", "catch up"

  start_catch_up → {"type":"start_catch_up","dayNumber":N}
    "do day 3", "start missed lesson", "catch up on day 5"

GENERAL:
  conversation → {"type":"conversation","message":"..."}
    General chat, greetings, questions not related to above

═══════════════════════════════════════════════════════════════════
CONTEXT-AWARE PARSING:
═══════════════════════════════════════════════════════════════════

When in an active lesson (indicated by lessonState):
- Short answers like "hello", "konnichiwa", "です" should be answer_question, not conversation
- Questions like "why?" or "what?" should be request_explanation
- "I don't know" or "skip" should be skip_exercise
- "hint" should be request_hint

When NOT in an active lesson:
- Japanese text may be free_conversation (wanting to practice)
- "hello" or "hi" is just conversation
- Questions about Japanese can be request_explanation with topic

═══════════════════════════════════════════════════════════════════
EXAMPLES:
═══════════════════════════════════════════════════════════════════

User is in lesson, asked "How do you say 'good morning'?":
  "ohayo" → {"type":"answer_question","answer":"ohayo","inputType":"text"}
  "おはよう" → {"type":"answer_question","answer":"おはよう","inputType":"text"}
  "I don't remember" → {"type":"request_hint","hintLevel":1}
  "skip" → {"type":"skip_exercise"}

User is NOT in lesson:
  "start lesson" → {"type":"start_lesson"}
  "おはようございます" → {"type":"free_conversation","message":"おはようございます","inputType":"text"}
  "how do I say thank you?" → {"type":"request_explanation","topic":"how to say thank you"}
  "hello!" → {"type":"conversation","message":"hello!"}
`;

export async function parseIntent(
  userMessage: string,
  conversationHistory: ConversationMessage[] = [],
  activeLessonState: ActiveLessonState | null = null,
): Promise<Intent> {
  const client = getClient();

  // Build lesson context info
  let lessonContext = "";
  if (activeLessonState) {
    lessonContext = `\n\n[LESSON CONTEXT: User is in Day ${activeLessonState.dayNumber}, phase: ${activeLessonState.phase}`;
    if (activeLessonState.currentExercise) {
      lessonContext += `, current exercise type: ${activeLessonState.currentExercise.type}`;
    }
    lessonContext += "]";
  } else {
    lessonContext = "\n\n[LESSON CONTEXT: User is NOT currently in an active lesson]";
  }

  const systemPrompt = getCurrentTimeContext() + INTENT_PARSING_PROMPT + lessonContext;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // Only include last 10 messages for context
  const recentHistory = conversationHistory.slice(-10);
  for (const msg of recentHistory) {
    const prefix = msg.role === "user" ? `[${formatTimestamp(msg.timestamp)}] ` : "";
    messages.push({
      role: msg.role,
      content: prefix + msg.content,
    });
  }

  messages.push({ role: "user", content: userMessage });

  const response = await client.chat.completions.create({
    model: getIntentModel(),
    max_tokens: 500,
    messages,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from LLM");
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const intent = JSON.parse(jsonText) as Intent;
    return intent;
  } catch (error) {
    console.error("Failed to parse intent:", content, error);
    return {
      type: "conversation",
      message: userMessage,
    };
  }
}

// ==========================================
// Action Response Generation
// ==========================================

export async function generateActionResponse(
  actionContext: ActionContext,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  let prompt: string;

  switch (actionContext.type) {
    case "lesson_intro":
      prompt = `Start Day ${actionContext.dayNumber} lesson: "${actionContext.title}".

IMPORTANT: This is ONLY the welcome message. DO NOT teach any content yet - that comes in separate messages.

Write a SHORT (2-3 sentences max) excited greeting that:
- Welcomes them to today's lesson
- Mentions the theme "${actionContext.title}" briefly
- Says you'll start with vocabulary

DO NOT: list vocabulary, explain grammar, show examples, or teach anything yet. Just greet them warmly and tell them we're about to start.`;
      break;

    case "teaching_vocabulary":
      prompt = `${actionContext.index > 0 ? "Good! " : ""}Teach vocabulary item ${actionContext.index + 1}/${actionContext.total}:
Japanese: ${actionContext.item.japanese}
Reading: ${actionContext.item.reading}
Meaning: ${actionContext.item.meaning}
Part of speech: ${actionContext.item.partOfSpeech}
${actionContext.item.exampleSentence ? `Example: ${actionContext.item.exampleSentence}` : ""}

${actionContext.index > 0 ? "Start with brief acknowledgment (e.g., \"Good!\", \"That's right!\") then present the new word." : ""}
Keep it SHORT (3-5 lines max). Present the word, its meaning, and one quick usage tip. End by asking them to try saying/typing it. Don't overwhelm with info.`;
      break;

    case "teaching_grammar":
      prompt = `${actionContext.index > 0 ? "Good! " : ""}Teach grammar pattern ${actionContext.index + 1}/${actionContext.total}:
Pattern: ${actionContext.item.pattern}
Meaning: ${actionContext.item.meaning}
Formation: ${actionContext.item.formation}
Example: ${actionContext.item.examples[0]?.japanese} - ${actionContext.item.examples[0]?.meaning}
${actionContext.item.notes ? `Notes: ${actionContext.item.notes}` : ""}

${actionContext.index > 0 ? "Start with brief acknowledgment then present the new pattern." : ""}
Keep it SHORT (4-6 lines max). Show the pattern, explain how to form it, give ONE example. Ask them to try using it.`;
      break;

    case "teaching_kanji":
      prompt = `${actionContext.index > 0 ? "Good! " : ""}Teach kanji ${actionContext.index + 1}/${actionContext.total}:
Character: ${actionContext.item.character}
Meanings: ${actionContext.item.meanings.join(", ")}
On'yomi: ${actionContext.item.readings.onyomi.join(", ") || "none"}
Kun'yomi: ${actionContext.item.readings.kunyomi.join(", ") || "none"}
${actionContext.item.mnemonics ? `Memory aid: ${actionContext.item.mnemonics}` : ""}
Example word: ${actionContext.item.examples[0]?.word} (${actionContext.item.examples[0]?.reading}) - ${actionContext.item.examples[0]?.meaning}

${actionContext.index > 0 ? "Start with brief acknowledgment then present the new kanji." : ""}
Keep it SHORT (4-6 lines max). Show the kanji, its main meaning, the mnemonic, and ONE example word. Ask them to try recognizing it.`;
      break;

    case "exercise_prompt":
      prompt = `Present this exercise to the student:
Type: ${actionContext.exercise.type}
Prompt: ${actionContext.exercise.prompt}
This is testing: ${actionContext.exercise.itemType} - ${actionContext.exercise.itemId}

Frame the question naturally, encourage them to try.`;
      break;

    case "exercise_correct":
      prompt = `The student answered correctly! Item: ${actionContext.item}. ${actionContext.streak > 1 ? `They're on a ${actionContext.streak} streak!` : ""} Give brief, warm praise and move forward.`;
      break;

    case "exercise_incorrect":
      prompt = `The student answered "${actionContext.userAnswer}" but the correct answer is "${actionContext.correctAnswer}".
Explanation: ${actionContext.explanation}

Gently correct them without making them feel bad. Explain why the correct answer is right.`;
      break;

    case "hint_given":
      prompt = `Provide this hint: "${actionContext.hint}". ${actionContext.hintsRemaining} hints remaining. Present it encouragingly.`;
      break;

    case "lesson_complete":
      prompt = `Day ${actionContext.dayNumber} is complete! Score: ${actionContext.score}%. Current streak: ${actionContext.streak} days. Celebrate their achievement appropriately based on the score. Mention what they learned.`;
      break;

    case "lesson_paused":
      prompt = `The student paused Day ${actionContext.dayNumber} during ${actionContext.progress}. Acknowledge it warmly, let them know their progress is saved.`;
      break;

    case "lesson_resumed":
      prompt = `The student is resuming Day ${actionContext.dayNumber}, currently in ${actionContext.phase}. Welcome them back and remind them where they were.`;
      break;

    case "progress_summary":
      prompt = `Show progress summary:
- Days completed: ${actionContext.daysCompleted}/30
- Current streak: ${actionContext.currentStreak} days
- Vocabulary mastered: ${actionContext.vocabMastered}
- Grammar patterns mastered: ${actionContext.grammarMastered}
- Kanji mastered: ${actionContext.kanjiMastered}

Present this encouragingly. Highlight achievements.`;
      break;

    case "weak_areas":
      const areasList = actionContext.areas.map((a) => `${a.item} (${a.type}) - ${a.errorCount} errors`).join("\n");
      prompt = `The student asked about weak areas. Here's what they're struggling with:\n${areasList}\n\nPresent this constructively, offer to practice these areas.`;
      break;

    case "free_conversation":
      prompt = `The student wants to practice Japanese conversation. They said: "${actionContext.userMessage}" ${actionContext.inJapanese ? "(in Japanese)" : ""}. Engage naturally, gently correct any mistakes, keep the conversation going at their level.`;
      break;

    case "missed_lessons":
      prompt = `The student has missed ${actionContext.total} lesson(s): Days ${actionContext.days.join(", ")}. Let them know warmly, no judgment. Offer to catch up.`;
      break;

    case "lesson_time_set":
      const period = actionContext.hour >= 12 ? "PM" : "AM";
      const displayHour = actionContext.hour > 12 ? actionContext.hour - 12 : actionContext.hour === 0 ? 12 : actionContext.hour;
      const timeStr = `${displayHour}:${actionContext.minute.toString().padStart(2, "0")} ${period}`;
      prompt = `The student set their daily lesson time to ${timeStr}. Confirm warmly.`;
      break;

    case "conversation":
      prompt = `The student said: "${actionContext.message}". Respond naturally as Emi.`;
      break;

    default:
      prompt = `Respond appropriately to the current context.`;
  }

  const systemPrompt = EMI_PERSONALITY;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 1000,
    messages: buildContextMessages(systemPrompt, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "I'm sorry, I had trouble generating a response. Could you try again?";
  }

  return content;
}

// ==========================================
// Simple Answer Evaluation (No Personality)
// ==========================================

/**
 * Evaluates if a student's answer is correct during teaching phases.
 * Simple check: does the student's response match the expected Japanese word/phrase?
 * Accepts kanji, hiragana, or romaji.
 */
export async function evaluateTeachingAnswer(
  studentAnswer: string,
  expectedItem: string,
): Promise<boolean> {
  const client = getClient();

  // Very simple prompt - just ask if it's a match
  const prompt = `Does the student's answer match the expected Japanese?

Expected: ${expectedItem}
Student said: ${studentAnswer}

Rules:
- Kanji = hiragana (私 = わたし, お願い = おねがい)
- Romaji OK (konnichiwa = こんにちは)
- Punctuation doesn't matter
- If student used the word correctly in a sentence, that's correct

Answer only: YES or NO`;

  try {
    const response = await client.chat.completions.create({
      model: getIntentModel(),
      max_tokens: 10,
      temperature: 0,
      messages: [
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim().toUpperCase() || "";
    const isCorrect = content.includes("YES");

    console.log(`[evaluateTeachingAnswer] Expected: "${expectedItem}", Got: "${studentAnswer}", LLM: "${content}", Result: ${isCorrect}`);

    return isCorrect;
  } catch (error) {
    console.error("[evaluateTeachingAnswer] Error:", error);
    return false;
  }
}

// ==========================================
// Conversation Summary Generation
// ==========================================

export async function generateConversationSummary(
  messages: {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }[],
  existingSummary?: string,
): Promise<string> {
  const client = getClient();

  const formattedMessages = messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `[${time}] ${m.role === "user" ? "Student" : "Emi"}: ${m.content}`;
    })
    .join("\n");

  const summaryContext = existingSummary
    ? `EXISTING CONTEXT SUMMARY (from earlier conversation):\n${existingSummary}\n\n---\n\nNEWER MESSAGES TO INCORPORATE:\n${formattedMessages}`
    : `MESSAGES TO SUMMARIZE:\n${formattedMessages}`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `You are summarizing a Japanese language learning conversation between a student and Emi (a dog girl Japanese tutor). Create a concise summary that captures:

1. Learning progress (what they've been studying, any breakthroughs)
2. Areas of difficulty (words/grammar they struggled with)
3. Student's engagement level and preferences
4. Any specific topics or interests mentioned

Keep the summary factual and concise (2-4 sentences). This will be used for continuity in future lessons.`,
      },
      {
        role: "user",
        content: summaryContext,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return existingSummary || "Previous conversation context unavailable.";
  }

  return content;
}

// ==========================================
// Daily Lesson Prompt Generation
// ==========================================

export async function generateDailyLessonPrompt(
  dayNumber: number,
  streak: number,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = streak > 1
    ? `Generate a daily lesson prompt for Day ${dayNumber}. The student has a ${streak}-day streak! Acknowledge their consistency and invite them to today's lesson.`
    : `Generate a daily lesson prompt for Day ${dayNumber}. Warmly invite them to start today's lesson.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 300,
    messages: buildContextMessages(EMI_PERSONALITY, prompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `It's time for Day ${dayNumber}! Ready to continue your Japanese journey?`;
  }

  return content;
}

// ==========================================
// Weekly Progress Summary Generation
// ==========================================

export async function generateWeeklyProgress(
  daysCompleted: number,
  streak: number,
  vocabLearned: number,
  grammarLearned: number,
  kanjiLearned: number,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = `Generate a weekly progress summary:
- Days completed this week: ${daysCompleted}
- Current streak: ${streak} days
- New vocabulary learned: ${vocabLearned}
- Grammar patterns learned: ${grammarLearned}
- Kanji learned: ${kanjiLearned}

Celebrate their progress, mention specific achievements, encourage them for next week.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 500,
    messages: buildContextMessages(EMI_PERSONALITY, prompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Great work this week! You've made real progress in your Japanese studies.`;
  }

  return content;
}

// ==========================================
// Checklist-Based Lesson Response Generation
// ==========================================

const LESSON_RESPONSE_INSTRUCTIONS = `You are teaching a Japanese lesson. Use the checklist to track your progress.

RESPONSE FORMAT (JSON only, no markdown):
{
  "message": "Your teaching message to the student",
  "checklistAction": "none" | "complete" | "insert",
  "insertItem": { "content": "..." }  // Only if action is "insert"
}

CHECKLIST ACTIONS:
- "none": Stay on current item (user hasn't demonstrated understanding yet)
- "complete": Mark current item done and move to next (user understood it)
- "insert": Add a clarification item after current (user is confused, needs extra help)

TEACHING FLOW:
1. For TEACH items: Present the word/grammar/kanji, explain briefly, ask them to try
2. For PRACTICE items: Quiz them on what they've learned in this category
3. For CLARIFY items: Address the specific confusion, then try the original item again

WHEN TO COMPLETE:
- User correctly says/writes the word (kanji, hiragana, or romaji all count)
- User demonstrates understanding (even in a sentence)
- User answers practice question correctly

WHEN TO STAY (none):
- First presenting a new item
- User gives wrong answer (correct them, let them try again)
- User asks a question about the current item

WHEN TO INSERT:
- User is repeatedly confused
- User explicitly says they don't understand
- User's confusion reveals a gap in knowledge

Remember: ALWAYS output valid JSON. No markdown code blocks.`;

/**
 * Generate a lesson response using the checklist-based approach.
 * The LLM sees the full checklist and decides when to advance.
 */
export async function generateLessonResponse(
  checklist: LessonChecklist,
  conversationHistory: ConversationMessage[],
  userMessage: string,
): Promise<LessonLLMResponse> {
  const client = getClient();

  const checklistText = renderChecklistForLLM(checklist);
  const currentItem = getCurrentItem(checklist);

  // Build the system prompt with personality + checklist + instructions
  let systemPrompt = getCurrentTimeContext() + EMI_PERSONALITY;

  systemPrompt += `\n\n---LESSON CHECKLIST---
${checklistText}
---END CHECKLIST---

${LESSON_RESPONSE_INSTRUCTIONS}`;

  // Add current item focus
  if (currentItem) {
    systemPrompt += `\n\nCURRENT FOCUS: ${currentItem.type.toUpperCase()} - ${currentItem.displayText}`;
  } else {
    systemPrompt += `\n\nLESSON COMPLETE! All items have been covered. Congratulate the student and summarize what they learned.`;
  }

  // Build messages array
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add last 20 conversation messages
  const recentHistory = conversationHistory.slice(-20);
  for (const msg of recentHistory) {
    const prefix = msg.role === "user" ? `[${formatTimestamp(msg.timestamp)}] ` : "";
    messages.push({
      role: msg.role,
      content: prefix + msg.content,
    });
  }

  // Add current user message
  messages.push({ role: "user", content: userMessage });

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 1000,
    temperature: 0.7,
    messages,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return {
      message: "I'm sorry, I had trouble generating a response. Could you try again?",
      checklistAction: "none",
    };
  }

  // Parse JSON response
  try {
    let jsonText = content.trim();
    // Remove markdown code blocks if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonText) as LessonLLMResponse;

    // Validate the response
    if (!parsed.message || typeof parsed.message !== "string") {
      throw new Error("Invalid message in response");
    }
    if (!["none", "complete", "insert"].includes(parsed.checklistAction)) {
      parsed.checklistAction = "none";
    }

    console.log(`[generateLessonResponse] Action: ${parsed.checklistAction}, Message length: ${parsed.message.length}`);

    return parsed;
  } catch (error) {
    console.error("[generateLessonResponse] Failed to parse JSON:", content, error);

    // Fallback: treat the whole response as the message
    return {
      message: content,
      checklistAction: "none",
    };
  }
}

/**
 * Generate the lesson intro message when starting a new lesson with checklist.
 */
export async function generateLessonIntro(
  checklist: LessonChecklist,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = `Start Day ${checklist.dayNumber} lesson: "${checklist.title}".

This lesson has ${checklist.totalCount} items to cover.

Write a SHORT (2-3 sentences max) excited greeting that:
- Welcomes them to today's lesson
- Mentions the theme briefly
- Says you'll start now

DO NOT: list vocabulary, explain grammar, show examples, or teach anything yet. Just greet them warmly.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 300,
    messages: buildContextMessages(EMI_PERSONALITY, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Welcome to Day ${checklist.dayNumber}: ${checklist.title}! Let's get started!`;
  }

  return content;
}

/**
 * Generate a lesson completion message.
 */
export async function generateLessonComplete(
  checklist: LessonChecklist,
  streak: number,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = `Day ${checklist.dayNumber} "${checklist.title}" is complete!
The student completed all ${checklist.completedCount} items.
Current streak: ${streak} days.

Celebrate their achievement! This is a moment for excitement. Mention what they learned (${checklist.title}) and encourage them to come back tomorrow.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 400,
    messages: buildContextMessages(EMI_PERSONALITY, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Congratulations! You've completed Day ${checklist.dayNumber}! See you tomorrow!`;
  }

  return content;
}
