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
  VocabularyItem,
  GrammarPattern,
  KanjiItem,
} from "./types.js";
import { renderChecklistForLLM, getCurrentItem } from "./lesson-checklist.js";
import { getSyllabusDay } from "./syllabus.js";

// Initialize Braintrust logger for tracing
const braintrustApiKey = process.env.BRAINTRUST_API_KEY;
const braintrustProjectId = process.env.BRAINTRUST_PROJECT_ID;

console.log(
  `[Braintrust] Initializing with project ID: ${braintrustProjectId}, API key set: ${!!braintrustApiKey}`,
);

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

  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: fullSystemPrompt }];

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

  restart_lesson → {"type":"restart_lesson","dayNumber":N}
    "restart lesson", "start over", "begin again", "restart", "restart day 3"
    Use when user wants to restart current lesson from beginning
    dayNumber is optional - defaults to current active lesson

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

RESET:
  reset_progress → {"type":"reset_progress","scope":"all"|"vocabulary"|"lessons"|"current_lesson","confirmed":boolean}
    "/reset", "/reset all", "reset all progress", "start fresh", "clear my progress" → scope: "all", confirmed: false
    "/reset vocabulary", "reset vocabulary", "clear vocab progress" → scope: "vocabulary", confirmed: false
    "/reset lessons", "reset lessons", "clear lesson history" → scope: "lessons", confirmed: false
    "/reset current", "reset current lesson", "restart from scratch" → scope: "current_lesson", confirmed: false
    "yes, reset everything", "yes reset all", "yes" (after reset prompt) → scope: "all", confirmed: true
    "yes, reset vocabulary" → scope: "vocabulary", confirmed: true
    "yes, reset lessons" → scope: "lessons", confirmed: true

DEBUG:
  debug_context → {"type":"debug_context"}
    "/debug", "show debug", "show context", "debug info"

GENERAL:
  conversation → {"type":"conversation","message":"..."}
    General chat, greetings, questions not related to above

═══════════════════════════════════════════════════════════════════
CONTEXT-AWARE PARSING:
═══════════════════════════════════════════════════════════════════

When in an active lesson (indicated by lessonState):
- ALL user messages during a lesson should be → conversation
- The lesson LLM handles answers, hints, skips, explanations directly
- Only parse explicit control intents: "pause", "stop lesson", "show progress"

When NOT in an active lesson:
- Japanese text may be free_conversation (wanting to practice)
- "hello" or "hi" is just conversation
- Questions about Japanese like "how do I say X?" should be conversation (Emi will respond naturally)

═══════════════════════════════════════════════════════════════════
EXAMPLES:
═══════════════════════════════════════════════════════════════════

User is in lesson:
  "ohayo" → {"type":"conversation","message":"ohayo"}
  "おはよう" → {"type":"conversation","message":"おはよう"}
  "I don't remember" → {"type":"conversation","message":"I don't remember"}
  "skip" → {"type":"conversation","message":"skip"}
  "hint" → {"type":"conversation","message":"hint"}
  "pause" → {"type":"pause_lesson"}

User is NOT in lesson:
  "start lesson" → {"type":"start_lesson"}
  "おはようございます" → {"type":"free_conversation","message":"おはようございます","inputType":"text"}
  "how do I say thank you?" → {"type":"conversation","message":"how do I say thank you?"}
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

  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

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

${actionContext.index > 0 ? 'Start with brief acknowledgment (e.g., "Good!", "That\'s right!") then present the new word.' : ""}
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
      const areasList = actionContext.areas
        .map((a) => `${a.item} (${a.type}) - ${a.errorCount} errors`)
        .join("\n");
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
      const displayHour =
        actionContext.hour > 12
          ? actionContext.hour - 12
          : actionContext.hour === 0
            ? 12
            : actionContext.hour;
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
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.choices[0]?.message?.content?.trim().toUpperCase() || "";
    const isCorrect = content.includes("YES");

    console.log(
      `[evaluateTeachingAnswer] Expected: "${expectedItem}", Got: "${studentAnswer}", LLM: "${content}", Result: ${isCorrect}`,
    );

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

  // Anchor to the official syllabus title to avoid topic drift
  let title: string | null = null;
  try {
    const day = await getSyllabusDay(dayNumber);
    title = day?.title || null;
  } catch {}

  const dayLabel = title ? `Day ${dayNumber}: "${title}"` : `Day ${dayNumber}`;

  const prompt =
    streak > 1
      ? `Generate a daily lesson prompt for ${dayLabel}. The student has a ${streak}-day streak! Acknowledge their consistency and invite them to today's lesson.`
      : `Generate a daily lesson prompt for ${dayLabel}. Warmly invite them to start today's lesson.`;

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

STRICT CONTENT BOUNDARY:
- Teach ONLY items listed in the current checklist for TODAY'S DAY.
- Do NOT introduce or switch to topics from other days unless they appear in the checklist.
- If prior conversation or memory conflicts with the checklist, follow the checklist.

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
1. For REVIEW items: Quick recall exercise from previous days - keep it brief (30-60 sec)
   - Start with "Let's quickly review..." or "Remember this from Day X?"
   - Ask them to recall/produce the item, don't re-teach from scratch
   - Move on after one correct attempt
   - If they struggle, give a quick reminder then move on (we'll review again later)

2. For TEACH items: **Use the TEACHING CONTENT section below if provided**
   - First message: PRESENT the word/pattern/kanji with its meaning
   - Show an example if available in TEACHING CONTENT
   - THEN ask them to try producing it
   - Do NOT skip straight to quizzing - you MUST teach first!

3. For PRACTICE items: Quiz them on what they've learned in this category
4. For CLARIFY items: Address the specific confusion, then try the original item again

CRITICAL TEACHING RULES (keep to ≤6 lines):
- You MUST present the item BEFORE asking them to try
- Use examples from TEACHING CONTENT when available
- Don't assume they know it - this is NEW material
- Do NOT repeat yourself: present each item ONCE concisely (no duplicate lines/blocks)

EXAMPLES MUST BE APPROPRIATE:
- ONLY use vocabulary, kanji, or grammar the student has ALREADY LEARNED
- Do NOT introduce new material in examples without fully explaining it
- If an example contains unfamiliar elements, either explain them OR use a simpler example
- When in doubt, keep examples simple and focused on just the current item

TOPIC DISCIPLINE:
- Do not teach days-of-the-week, dates, or any other content unless the current checklist item is about that topic.

BAD: Teaching いち (one) with "一本 (ippon)" - introduces unexplained kanji and counter
GOOD: Teaching いち (one) with "Let's count: いち, に, さん!" - simple and focused

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

HANDLING USER REQUESTS:
- "hint" / "help" / "I'm stuck": Give a helpful hint using TEACHING CONTENT, stay on current item (action: "none")
- "skip" / "next" / "I don't know": Say "No problem, we'll review this later" and mark complete (action: "complete")
- "explain" / "what does X mean" / "why": Explain using TEACHING CONTENT, stay on current item (action: "none")

AUTO-CONTINUE PLACEHOLDER:
- The message "[AUTO_CONTINUE]" indicates a system placeholder (no new student input).
- When the latest user message is "[AUTO_CONTINUE]" OR empty/irrelevant, DO NOT mark items complete.
- Present or continue with the current/next item and set checklistAction to "none".
- Only mark "complete" when the student's actual message demonstrates understanding or they explicitly say "skip"/"next"/"I don't know".

Remember: ALWAYS output valid JSON. No markdown code blocks.`;

/**
 * Content for the current teaching item (vocabulary, grammar, or kanji)
 */
export interface TeachingItemContent {
  vocabularyItem?: VocabularyItem;
  grammarPattern?: GrammarPattern;
  kanjiItem?: KanjiItem;
}

/**
 * Format teaching content for the LLM system prompt
 */
function formatTeachingContent(content: TeachingItemContent): string {
  let output = "\n\n---TEACHING CONTENT---\n";

  if (content.vocabularyItem) {
    const v = content.vocabularyItem;
    output += `Word: ${v.japanese} (${v.reading})\n`;
    output += `Meaning: ${v.meaning}\n`;
    output += `Part of speech: ${v.partOfSpeech}\n`;
    if (v.exampleSentence) {
      output += `Example: ${v.exampleSentence}\n`;
      if (v.exampleReading) output += `Reading: ${v.exampleReading}\n`;
      if (v.exampleMeaning) output += `Translation: ${v.exampleMeaning}\n`;
    }
  }

  if (content.grammarPattern) {
    const g = content.grammarPattern;
    output += `Pattern: ${g.pattern}\n`;
    output += `Meaning: ${g.meaning}\n`;
    output += `Formation: ${g.formation}\n`;
    if (g.examples && g.examples.length > 0) {
      output += `Examples:\n`;
      for (const ex of g.examples) {
        output += `  - ${ex.japanese} (${ex.reading}) - ${ex.meaning}\n`;
      }
    }
    if (g.notes) output += `Notes: ${g.notes}\n`;
  }

  if (content.kanjiItem) {
    const k = content.kanjiItem;
    output += `Kanji: ${k.character}\n`;
    output += `Meanings: ${k.meanings.join(", ")}\n`;
    output += `On'yomi: ${k.readings.onyomi.join(", ")}\n`;
    output += `Kun'yomi: ${k.readings.kunyomi.join(", ")}\n`;
    output += `Strokes: ${k.strokeCount}\n`;
    if (k.mnemonics) output += `Mnemonic: ${k.mnemonics}\n`;
    if (k.examples && k.examples.length > 0) {
      output += `Examples:\n`;
      for (const ex of k.examples) {
        output += `  - ${ex.word} (${ex.reading}) - ${ex.meaning}\n`;
      }
    }
  }

  output += "---END TEACHING CONTENT---";
  return output;
}

/**
 * Generate a lesson response using the checklist-based approach.
 * The LLM sees the full checklist and decides when to advance.
 */
export async function generateLessonResponse(
  checklist: LessonChecklist,
  conversationHistory: ConversationMessage[],
  userMessage: string,
  currentItemContent?: TeachingItemContent,
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

    // Add detailed teaching content for TEACH and REVIEW items
    if ((currentItem.type === "teach" || currentItem.type === "review") && currentItemContent) {
      systemPrompt += formatTeachingContent(currentItemContent);
    }
  } else {
    systemPrompt += `\n\nLESSON COMPLETE! All items have been covered. Congratulate the student and summarize what they learned.`;
  }

  // Build messages array
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

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

    console.log(
      `[generateLessonResponse] Action: ${parsed.checklistAction}, Message length: ${parsed.message.length}`,
    );
    // De-duplicate any accidental repeated lines/blocks in the assistant message
    parsed.message = dedupeAssistantMessage(parsed.message);
    return parsed;
  } catch (error) {
    console.error("[generateLessonResponse] Failed to parse JSON:", content, error);

    // Fallback: treat the whole response as the message
    return {
      message: dedupeAssistantMessage(content),
      checklistAction: "none",
    };
  }
}

function dedupeAssistantMessage(text: string): string {
  // First pass: drop consecutive duplicate lines
  const lines = text.split(/\r?\n/);
  const lineOut: string[] = [];
  let prevTrim = "\u0000";
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0 && t === prevTrim) continue;
    lineOut.push(line);
    prevTrim = t;
  }
  const compact = lineOut.join("\n");

  // Second pass: drop consecutive duplicate paragraphs (separated by blank lines)
  const paras = compact.split(/(?:\r?\n){2,}/);
  const paraOut: string[] = [];
  let prevParaNorm = "\u0000";
  for (const p of paras) {
    const norm = p.trim().replace(/[ \t]+/g, " ");
    if (norm.length > 0 && norm === prevParaNorm) continue;
    paraOut.push(p.trimEnd());
    prevParaNorm = norm;
  }
  return paraOut.join("\n\n");
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

// ==========================================
// Tae Kim Flexible Lesson Functions
// ==========================================

import type {
  FlexibleLessonState,
  TaeKimLessonContent,
  LessonComponent,
  FlexibleLessonResponse,
} from "./types.js";

const EMI_PERSONALITY_TAEKIM = `You are Emi, a friendly Japanese tutor teaching via Telegram.

## Teaching Style
- Direct and practical - skip theory, jump to application
- Challenge-focused - increase complexity if the student finds it easy
- Real-world scenarios ONLY (convenience stores, train stations, cafes, online shopping, texting friends)
- NO classroom scenarios
- NO romaji - only Japanese with English translations

## Sentence Format (CRITICAL)
For EVERY Japanese sentence, use this exact triad format:
昨日、友達と映画を見ました。
きのう、ともだちとえいがをみました。
Yesterday, I watched a movie with a friend.

Keep the three lines together for each sentence.

## Exercise Format
For fill-in-blank exercises, use parentheses: (     )
Example: 私(     )学生です。

## Personality
- Warm and encouraging but not over-the-top
- Celebrate genuine progress
- Gently correct mistakes
- Keep responses focused and concise`;

const FLEXIBLE_LESSON_PROMPT = `You are teaching a Japanese lesson based on Tae Kim's Grammar Guide.

## Today's Topic
{topic}: {subPatterns}

## Current Component
{component}

## Component Context
{componentContext}

## Teaching Flow
Guide the student naturally through this component. When ready, move to the next.

## Response Format
Respond naturally as Emi. At the end of your message, add a status line:
[COMPONENT: {component}] [PROGRESS: {description}]

Examples:
[COMPONENT: grammar_intro] [PROGRESS: explained pattern, student practicing]
[COMPONENT: vocabulary] [PROGRESS: 5/15 words introduced]
[COMPONENT: exercises] [PROGRESS: 3 correct, moving to writing]
[COMPONENT: complete] [PROGRESS: lesson finished]`;

/**
 * Parse the flexible response to extract component and progress
 */
export function parseFlexibleResponse(response: string): FlexibleLessonResponse {
  // Default values
  let message = response;
  let component: LessonComponent = "grammar_intro";
  let progress = "";

  // Try to extract [COMPONENT: ...] [PROGRESS: ...]
  const statusMatch = response.match(/\[COMPONENT:\s*([^\]]+)\]\s*\[PROGRESS:\s*([^\]]+)\]/i);

  if (statusMatch) {
    // Remove the status line from the message
    message = response.replace(statusMatch[0], "").trim();

    const componentStr = statusMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
    progress = statusMatch[2].trim();

    // Map to valid component
    const componentMap: Record<string, LessonComponent> = {
      grammar_intro: "grammar_intro",
      grammar: "grammar_intro",
      vocabulary: "vocabulary",
      vocab: "vocabulary",
      kanji: "kanji",
      reading_practice: "reading_practice",
      reading: "reading_practice",
      dialogue_practice: "dialogue_practice",
      dialogue: "dialogue_practice",
      exercises: "exercises",
      exercise: "exercises",
      writing_practice: "writing_practice",
      writing: "writing_practice",
      complete: "complete",
      finished: "complete",
      done: "complete",
    };

    component = componentMap[componentStr] || "grammar_intro";
  }

  return { message, component, progress };
}

/**
 * Check if a component is complete based on progress description
 */
export function isComponentComplete(progress: string): boolean {
  const lowerProgress = progress.toLowerCase();
  return (
    lowerProgress.includes("complete") ||
    lowerProgress.includes("finished") ||
    lowerProgress.includes("done") ||
    lowerProgress.includes("moving to")
  );
}

/**
 * Generate a flexible lesson response
 */
export async function generateFlexibleLessonResponse(
  userMessage: string,
  state: FlexibleLessonState,
  lessonContent: TaeKimLessonContent,
  componentContext: string,
  conversationContext?: ConversationContext,
): Promise<FlexibleLessonResponse> {
  const client = getClient();

  const prompt = FLEXIBLE_LESSON_PROMPT.replace("{topic}", lessonContent.topic)
    .replace("{subPatterns}", lessonContent.subPatterns.join(", "))
    .replace("{component}", state.currentComponent)
    .replace("{componentContext}", componentContext);

  const systemPrompt = EMI_PERSONALITY_TAEKIM + "\n\n" + prompt;

  const messages = buildContextMessages(systemPrompt, userMessage, conversationContext);

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 1500,
    messages,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return {
      message: "I'm sorry, I couldn't generate a response. Please try again.",
      component: state.currentComponent,
      progress: "",
    };
  }

  return parseFlexibleResponse(content);
}

/**
 * Generate intro message for a Tae Kim lesson
 */
export async function generateTaeKimLessonIntro(
  lessonContent: TaeKimLessonContent,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = `You're starting Lesson ${lessonContent.lessonNumber}: "${lessonContent.topic}"

Grammar patterns: ${lessonContent.subPatterns.join(", ")}

Learning objectives:
${lessonContent.learningObjectives.map((o) => `- ${o}`).join("\n")}

Welcome the student warmly and give a brief overview of what they'll learn today. Keep it concise and exciting!`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 400,
    messages: buildContextMessages(EMI_PERSONALITY_TAEKIM, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Welcome to Lesson ${lessonContent.lessonNumber}: ${lessonContent.topic}! Let's learn ${lessonContent.subPatterns.slice(0, 3).join(", ")}!`;
  }

  return content;
}

/**
 * Generate completion message for a Tae Kim lesson
 */
export async function generateTaeKimLessonComplete(
  lessonContent: TaeKimLessonContent,
  score: number,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = `Lesson ${lessonContent.lessonNumber} "${lessonContent.topic}" is complete!
The student's score: ${score}%

Grammar patterns mastered: ${lessonContent.subPatterns.join(", ")}

Celebrate their achievement! Summarize what they learned and encourage them to practice. Suggest they try the next lesson when ready.`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 400,
    messages: buildContextMessages(EMI_PERSONALITY_TAEKIM, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Congratulations! You've completed Lesson ${lessonContent.lessonNumber}: ${lessonContent.topic}! Score: ${score}%`;
  }

  return content;
}

// ==========================================
// NEW UNIFIED LESSON SYSTEM - teachLesson
// ==========================================

import type { StoredLessonContent, StoredLessonState } from "./redis.js";
import { lessonToolDefinitions, executeToolCall, getToolsDescription } from "./lesson-tools.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * System prompt for the unified lesson teaching
 * Gives the LLM full control over the lesson flow
 */
function buildTeachingSystemPrompt(
  lesson: StoredLessonContent,
  state: StoredLessonState,
  userProfile: { displayName: string; strugglingAreas?: string[]; difficultyLevel?: string },
): string {
  const currentComponent = state.currentComponent;

  // Build lesson content as readable text
  const lessonContent = `
# Lesson ${lesson.lessonNumber}: ${lesson.topic}

## Grammar Patterns
${lesson.grammarPatterns.join(", ")}

## Grammar Explanation
${lesson.grammarExplanation}

## Vocabulary (${lesson.vocabulary.length} words)
${lesson.vocabulary
  .map(
    (v, i) =>
      `${i + 1}. **${v.word}** (${v.reading}) - ${v.meaning}${v.mnemonic ? `\n   Mnemonic: ${v.mnemonic}` : ""}`,
  )
  .join("\n")}

## Kanji (${lesson.kanji.length} characters)
${lesson.kanji
  .map(
    (k) =>
      `**${k.character}** - ${k.meanings.join(", ")}
   On: ${k.onyomi.join(", ")} | Kun: ${k.kunyomi.join(", ")}${k.mnemonic ? `\n   Mnemonic: ${k.mnemonic}` : ""}`,
  )
  .join("\n\n")}

## Reading Practice
Scenario: ${lesson.readingPassage.scenario}
${lesson.readingPassage.sentences.map((s) => `${s.kanji}\n${s.kana}\n${s.english}`).join("\n\n")}

## Conversation Practice
Scenario: ${lesson.dialoguePractice.scenario}
Participants: ${lesson.dialoguePractice.participants.join(", ")}

${lesson.dialoguePractice.exchanges
  .map(
    (e) =>
      `**${e.speaker}:**\n${e.lines.map((l) => `${l.kanji}\n${l.kana}\n${l.english}`).join("\n")}`,
  )
  .join("\n\n")}
${lesson.dialoguePractice.practiceNotes ? `\nNotes: ${lesson.dialoguePractice.practiceNotes}` : ""}

## Practice Exercises
${lesson.exercises
  .map(
    (e, i) =>
      `${i + 1}. [${e.type}] ${e.prompt}${e.options ? `\n   Options: ${e.options.join(", ")}` : ""}
   Answer: ${e.expectedAnswers.join(" or ")}
   Explanation: ${e.explanation}`,
  )
  .join("\n\n")}
`;

  // Build student context
  const studentContext = `
## Student Info
- Name: ${userProfile.displayName}
- Current section: ${currentComponent}
- Vocabulary correct so far: ${state.vocabCorrect.length}
- Exercise results: ${state.exerciseResults.correct} correct, ${state.exerciseResults.incorrect} incorrect
${userProfile.strugglingAreas?.length ? `- Struggling with: ${userProfile.strugglingAreas.join(", ")}` : ""}
${userProfile.difficultyLevel ? `- Difficulty preference: ${userProfile.difficultyLevel}` : ""}
`;

  return `${getCurrentTimeContext()}${EMI_PERSONALITY_TAEKIM}

---

# YOUR LESSON CONTENT

${lessonContent}

---

${studentContext}

---

# TEACHING INSTRUCTIONS

You are teaching this lesson to ${userProfile.displayName}. You have FULL CONTROL over the lesson flow.

## Current Section: ${currentComponent.toUpperCase()}

Follow this natural teaching order:
1. **grammar** - Explain the grammar patterns with examples
2. **vocabulary** - Teach the vocabulary words with mnemonics
3. **kanji** - Introduce the kanji characters
4. **reading** - Practice reading the passage together
5. **dialogue** - Role-play the conversation (you play one part, student plays the other)
6. **exercises** - Quiz the student with the practice exercises
7. **complete** - Congratulate and wrap up

## How to Teach

- Be conversational and encouraging, not robotic
- Teach one concept at a time, don't overwhelm
- Ask the student to try after explaining something
- When they answer, evaluate with LEEWAY (like a real teacher):
  - Close enough = correct (acknowledge and maybe mention the exact answer)
  - Only clearly wrong = incorrect (gently correct, explain why)
- Move naturally between topics when the student seems ready
- Use the tools to track their progress in the background

## Evaluating Answers

Be lenient like a real teacher:
- Accept kanji, hiragana, or reasonable romanization
- Accept synonyms and close translations
- Only mark wrong if grammatically incorrect or completely off
- When something could be interpreted differently, mention the alternative

${getToolsDescription()}

Remember: You're a teacher, not a quiz machine. Make learning enjoyable!
`;
}

/**
 * Result from teachLesson function
 */
export interface TeachLessonResult {
  message: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  lessonCompleted: boolean;
}

/**
 * Main teaching function for the new unified lesson system.
 * Gives the LLM full lesson content and tools, lets it teach naturally.
 */
export async function teachLesson(
  chatId: number,
  userMessage: string,
  lesson: StoredLessonContent,
  state: StoredLessonState,
  userProfile: { displayName: string; strugglingAreas?: string[]; difficultyLevel?: string },
  conversationHistory: ConversationMessage[],
): Promise<TeachLessonResult> {
  const client = getClient();

  // Build system prompt with full lesson content
  const systemPrompt = buildTeachingSystemPrompt(lesson, state, userProfile);

  // Build messages
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

  // Add conversation history (last 20 messages)
  const recentHistory = conversationHistory.slice(-20);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Add current user message
  messages.push({ role: "user", content: userMessage });

  // Call LLM with tools
  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 1500,
    temperature: 0.7,
    messages,
    tools: lessonToolDefinitions as ChatCompletionTool[],
    tool_choice: "auto",
  });

  const responseMessage = response.choices[0]?.message;
  if (!responseMessage) {
    return {
      message: "I'm sorry, I had trouble responding. Could you try again?",
      toolCalls: [],
      lessonCompleted: false,
    };
  }

  // Process any tool calls
  const toolCallResults: Array<{ name: string; args: Record<string, unknown>; result: unknown }> =
    [];
  let lessonCompleted = false;

  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    for (const toolCall of responseMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        console.error(`[teachLesson] Failed to parse tool args: ${toolCall.function.arguments}`);
      }

      const result = await executeToolCall(chatId, toolName, args);
      toolCallResults.push({ name: toolName, args, result });

      if (toolName === "complete_lesson" && result.success) {
        lessonCompleted = true;
      }
    }
  }

  // Get the text content
  let message = responseMessage.content || "";

  // If there were tool calls but no content, we need to make another call to get the response
  if (responseMessage.tool_calls && !message) {
    // Add the assistant's tool calls to messages
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: responseMessage.tool_calls,
    } as ChatCompletionMessageParam);

    // Add tool results
    for (let i = 0; i < responseMessage.tool_calls.length; i++) {
      messages.push({
        role: "tool",
        tool_call_id: responseMessage.tool_calls[i].id,
        content: JSON.stringify(toolCallResults[i].result),
      } as ChatCompletionMessageParam);
    }

    // Get the final response
    const finalResponse = await client.chat.completions.create({
      model: getChatModel(),
      max_tokens: 1500,
      temperature: 0.7,
      messages,
    });

    message = finalResponse.choices[0]?.message?.content || "";
  }

  // Clean up the message
  message = dedupeAssistantMessage(message);

  return {
    message,
    toolCalls: toolCallResults,
    lessonCompleted,
  };
}

/**
 * Generate a welcome message for starting a new lesson
 */
export async function generateUnifiedLessonIntro(
  lesson: StoredLessonContent,
  userProfile: { displayName: string },
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const prompt = `You're starting Lesson ${lesson.lessonNumber}: "${lesson.topic}" with ${userProfile.displayName}.

Grammar patterns: ${lesson.grammarPatterns.join(", ")}
Vocabulary count: ${lesson.vocabulary.length} words
Kanji count: ${lesson.kanji.length} characters

Write a warm, SHORT (3-4 sentences) welcome that:
- Greets the student by name
- Mentions what they'll learn today (the topic)
- Gets them excited to start
- Says you'll begin with the grammar explanation

Keep it natural and encouraging!`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 300,
    messages: buildContextMessages(EMI_PERSONALITY_TAEKIM, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Hi ${userProfile.displayName}! Welcome to Lesson ${lesson.lessonNumber}: ${lesson.topic}! Let's get started!`;
  }

  return content;
}
