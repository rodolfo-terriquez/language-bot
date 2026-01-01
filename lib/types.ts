// ==========================================
// Telegram Types (reused from ADHD bot)
// ==========================================

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ==========================================
// User Profile
// ==========================================

export interface UserProfile {
  chatId: number;
  displayName: string;
  lessonTime: string; // "HH:MM" format for daily lesson
  timezone: string; // User's timezone
  currentDay: number; // Current syllabus day (1-30)
  startDate: number; // Timestamp when course started
  totalLessonsCompleted: number; // Track progress
  currentStreak: number; // Consecutive days with completed lessons
  longestStreak: number; // Best streak achieved
  lastLessonDate?: string; // "YYYY-MM-DD" of last completed lesson
  lessonScheduleId?: string; // QStash schedule ID
  weeklyProgressScheduleId?: string;
  streakReminderScheduleId?: string;
  preferredInputMode: "text" | "voice" | "both";
  createdAt: number;
  updatedAt: number;
}

// ==========================================
// Lesson Progress
// ==========================================

export type LessonPhase =
  | "idle"
  | "intro"
  | "vocabulary_teaching"
  | "vocabulary_practice"
  | "grammar_teaching"
  | "grammar_practice"
  | "kanji_teaching"
  | "kanji_practice"
  | "assessment"
  | "review"
  | "complete";

export interface LessonProgress {
  chatId: number;
  dayNumber: number; // 1-30
  status: "not_started" | "in_progress" | "completed";
  scheduledDate: string; // "YYYY-MM-DD" when originally scheduled
  actualCompletedDate?: string; // "YYYY-MM-DD" when actually completed
  startedAt?: number;
  completedAt?: number;

  // Lesson phase tracking
  currentPhase: LessonPhase;

  // Assessment results
  vocabularyScore?: number; // 0-100
  grammarScore?: number;
  kanjiScore?: number;
  overallScore?: number;
  passingGrade: number; // Default 70

  // Time tracking
  totalTimeSpent: number; // Minutes
  attemptCount: number; // Number of times user attempted
}

// ==========================================
// Active Lesson State (in-progress session)
// ==========================================

export type ExerciseType =
  | "translation_to_english"
  | "translation_to_japanese"
  | "fill_in_blank"
  | "reading_practice"
  | "listening_comprehension"
  | "kanji_reading"
  | "kanji_meaning"
  | "grammar_formation"
  | "conversation_response"
  | "multiple_choice";

export interface CurrentExercise {
  type: ExerciseType;
  prompt: string;
  expectedAnswers: string[]; // Multiple acceptable answers
  hints: string[];
  hintsGiven: number;
  attempts: number;
  itemId: string; // Reference to vocab/grammar/kanji item
  itemType: "vocabulary" | "grammar" | "kanji";
}

export interface ActiveLessonState {
  chatId: number;
  dayNumber: number;
  phase: LessonPhase;

  // Current teaching/practice state
  currentItems: string[]; // IDs of items being taught
  currentItemIndex: number;

  // Exercise state
  currentExercise?: CurrentExercise;

  // Session stats
  correctThisSession: number;
  incorrectThisSession: number;
  hintsUsedThisSession: number;
  startedAt: number;
  lastInteraction: number;

  // Items that need review (got wrong)
  pendingReviewItems: string[];
}

// ==========================================
// Mastery Tracking
// ==========================================

export interface ItemMastery {
  itemId: string;
  itemType: "vocabulary" | "grammar" | "kanji";
  correctCount: number;
  incorrectCount: number;
  lastSeen: number;
  lastCorrect?: number;
  masteryLevel: 0 | 1 | 2 | 3 | 4 | 5; // 0=new, 5=mastered
  needsReview: boolean;
  dayIntroduced: number; // Which lesson day
}

export interface WeakArea {
  itemId: string;
  itemType: "vocabulary" | "grammar" | "kanji";
  errorPattern?: string; // Common mistake type
  reviewCount: number;
  addedAt: number;
}

export interface MasteryData {
  chatId: number;
  vocabulary: Record<string, ItemMastery>;
  grammar: Record<string, ItemMastery>;
  kanji: Record<string, ItemMastery>;
  weakAreas: WeakArea[];
  lastUpdated: number;
}

// ==========================================
// N5 Syllabus Structure
// ==========================================

export interface VocabularyItem {
  id: string;
  japanese: string; // "こんにちは"
  reading: string; // "konnichiwa" (romaji)
  meaning: string; // "Hello / Good afternoon"
  partOfSpeech: string; // "greeting", "noun", "verb", etc.
  exampleSentence?: string;
  exampleReading?: string;
  exampleMeaning?: string;
  difficulty: 1 | 2 | 3; // Within day's content
}

export interface GrammarPattern {
  id: string;
  pattern: string; // "〜は〜です"
  meaning: string; // "X is Y"
  formation: string; // How to form it
  examples: {
    japanese: string;
    reading: string;
    meaning: string;
  }[];
  notes?: string;
  difficulty: 1 | 2 | 3;
}

export interface KanjiItem {
  id: string;
  character: string; // "一"
  readings: {
    onyomi: string[]; // ["イチ", "イツ"]
    kunyomi: string[]; // ["ひと"]
  };
  meanings: string[]; // ["one"]
  strokeCount: number;
  examples: {
    word: string;
    reading: string;
    meaning: string;
  }[];
  radicals?: string[];
  mnemonics?: string; // Memory aid
}

export interface SyllabusDay {
  dayNumber: number;
  title: string; // "Greetings & Self Introduction"
  description: string;

  vocabulary: VocabularyItem[];
  grammar: GrammarPattern[];
  kanji: KanjiItem[];

  culturalNote?: string; // Optional cultural context
  practiceGoals: string[]; // What user should be able to do
  estimatedMinutes: number; // ~20-30 min per lesson
}

export interface N5Syllabus {
  level: "N5";
  totalDays: number;
  days: SyllabusDay[];
}

// ==========================================
// Intent Types
// ==========================================

export type Intent =
  // Lesson intents
  | StartLessonIntent
  | RestartLessonIntent
  | AnswerQuestionIntent
  | RequestHintIntent
  | SkipExerciseIntent
  | RequestExplanationIntent
  | PauseLessonIntent
  | ResumeLessonIntent
  // Progress intents
  | ShowProgressIntent
  | ShowWeakAreasIntent
  | ReviewVocabularyIntent
  | ShowLessonHistoryIntent
  // Settings intents
  | SetLessonTimeIntent
  | ChangePaceIntent
  // Free practice intents
  | FreeConversationIntent
  | PracticeTopicIntent
  // Catch-up intents
  | ShowMissedLessonsIntent
  | StartCatchUpIntent
  // General
  | ConversationIntent;

// Lesson intents
export interface StartLessonIntent {
  type: "start_lesson";
  dayNumber?: number; // Optional: specific day to start
}

export interface RestartLessonIntent {
  type: "restart_lesson";
  dayNumber?: number; // Optional: specific day to restart (defaults to current)
}

export interface AnswerQuestionIntent {
  type: "answer_question";
  answer: string;
  inputType: "text" | "voice";
}

export interface RequestHintIntent {
  type: "request_hint";
  hintLevel?: 1 | 2 | 3; // Progressive hints
}

export interface SkipExerciseIntent {
  type: "skip_exercise";
  reason?: string;
}

export interface RequestExplanationIntent {
  type: "request_explanation";
  topic?: string; // What to explain
}

export interface PauseLessonIntent {
  type: "pause_lesson";
}

export interface ResumeLessonIntent {
  type: "resume_lesson";
}

// Progress intents
export interface ShowProgressIntent {
  type: "show_progress";
}

export interface ShowWeakAreasIntent {
  type: "show_weak_areas";
}

export interface ReviewVocabularyIntent {
  type: "review_vocabulary";
  dayNumber?: number;
  topic?: string;
}

export interface ShowLessonHistoryIntent {
  type: "show_lesson_history";
}

// Settings intents
export interface SetLessonTimeIntent {
  type: "set_lesson_time";
  hour: number;
  minute: number;
}

export interface ChangePaceIntent {
  type: "change_pace";
  pace: "slower" | "normal" | "faster";
}

// Free practice intents
export interface FreeConversationIntent {
  type: "free_conversation";
  message: string;
  inputType: "text" | "voice";
}

export interface PracticeTopicIntent {
  type: "practice_topic";
  topic: string; // "greetings", "numbers", "colors"
}

// Catch-up intents
export interface ShowMissedLessonsIntent {
  type: "show_missed_lessons";
}

export interface StartCatchUpIntent {
  type: "start_catch_up";
  dayNumber: number;
}

// General conversation
export interface ConversationIntent {
  type: "conversation";
  message: string;
}

// ==========================================
// Notification Payloads
// ==========================================

export interface NotificationPayload {
  chatId: number;
  type:
    | "daily_lesson"
    | "streak_reminder"
    | "weekly_progress"
    | "follow_up_nudge"
    | "lesson_complete";
  dayNumber?: number;
}

// ==========================================
// Conversation History
// ==========================================

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  lessonContext?: {
    dayNumber: number;
    phase: LessonPhase;
  };
}

export interface ConversationData {
  messages: ConversationMessage[];
  summary?: string;
  summaryUpdatedAt?: number;
}

// ==========================================
// Exercise Evaluation Result
// ==========================================

export interface EvaluationResult {
  isCorrect: boolean;
  isPartiallyCorrect: boolean;
  feedback: string;
  correction?: string;
  explanation: string;
  masteryDelta: -1 | 0 | 1; // How to adjust mastery
}

// ==========================================
// LLM Action Context (for response generation)
// ==========================================

export type ActionContext =
  | { type: "lesson_intro"; dayNumber: number; title: string; topics: string[] }
  | {
      type: "teaching_vocabulary";
      item: VocabularyItem;
      index: number;
      total: number;
    }
  | {
      type: "teaching_grammar";
      item: GrammarPattern;
      index: number;
      total: number;
    }
  | { type: "teaching_kanji"; item: KanjiItem; index: number; total: number }
  | { type: "exercise_prompt"; exercise: CurrentExercise }
  | { type: "exercise_correct"; item: string; streak: number }
  | {
      type: "exercise_incorrect";
      userAnswer: string;
      correctAnswer: string;
      explanation: string;
    }
  | { type: "hint_given"; hint: string; hintsRemaining: number }
  | {
      type: "lesson_complete";
      dayNumber: number;
      score: number;
      streak: number;
    }
  | { type: "lesson_paused"; dayNumber: number; progress: string }
  | { type: "lesson_resumed"; dayNumber: number; phase: string }
  | {
      type: "progress_summary";
      daysCompleted: number;
      currentStreak: number;
      vocabMastered: number;
      grammarMastered: number;
      kanjiMastered: number;
    }
  | {
      type: "weak_areas";
      areas: Array<{ item: string; type: string; errorCount: number }>;
    }
  | { type: "free_conversation"; userMessage: string; inJapanese: boolean }
  | { type: "missed_lessons"; days: number[]; total: number }
  | { type: "lesson_time_set"; hour: number; minute: number }
  | { type: "conversation"; message: string };

// ==========================================
// Lesson Checklist (for LLM context tracking)
// ==========================================

export interface LessonChecklistItem {
  id: string; // "item_001"
  type: "teach" | "practice" | "clarify";
  status: "pending" | "current" | "complete";

  // Content from syllabus
  contentType: "vocabulary" | "grammar" | "kanji";
  contentId: string; // Reference like "v01_01"

  // Display info (for checklist rendering)
  displayText: string; // "こんにちは (konnichiwa) - Hello"

  // For dynamically inserted items
  isInserted?: boolean;
  insertedContent?: string;
}

export interface LessonChecklist {
  chatId: number;
  dayNumber: number;
  title: string; // "Greetings & Self-Introduction"

  items: LessonChecklistItem[];
  currentIndex: number;

  completedCount: number;
  totalCount: number;

  createdAt: number;
  lastUpdated: number;
}

export interface LessonLLMResponse {
  message: string; // What to send to user
  checklistAction: "none" | "complete" | "insert";
  insertItem?: {
    type: "clarify";
    content: string; // What to clarify
  };
}
