import OpenAI from "openai";
import type {
  TaeKimLesson,
  TaeKimLessonContent,
  ReadingPassage,
  DialoguePractice,
  PracticeExercise,
  WritingExercise,
  TriadSentence,
  VocabularyItem,
  KanjiItem,
  CoreVocabItem,
} from "./types.js";
import { getLesson } from "./curriculum.js";
import { getNextVocabulary, markVocabularySeen, formatVocabForLesson } from "./vocabulary.js";

// Get OpenRouter client
function getClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    timeout: 60000, // Longer timeout for content generation
    defaultHeaders: {
      "HTTP-Referer": process.env.BASE_URL || "https://language-bot.vercel.app",
      "X-Title": "Japanese Language Bot",
    },
  });
}

function getGenerationModel(): string {
  return process.env.OPENROUTER_MODEL_GENERATION || "anthropic/claude-sonnet-4";
}

// ==========================================
// Content Generation Prompts
// ==========================================

const TRIAD_FORMAT_INSTRUCTIONS = `
CRITICAL: For every Japanese sentence, use this exact triad format:
- Line 1: Japanese with kanji
- Line 2: Full hiragana reading
- Line 3: English translation

Example:
昨日、友達と映画を見ました。
きのう、ともだちとえいがをみました。
Yesterday, I watched a movie with a friend.

Keep the three lines together for each sentence. Do NOT use romaji.`;

const SCENARIO_REQUIREMENTS = `
SCENARIOS MUST BE:
- Real-world situations (convenience stores, train stations, cafes, online shopping, texting friends)
- NOT classroom scenarios
- Practical and immediately useful
- Age-appropriate for adult learners
- Set in Japan or Japanese-speaking contexts`;

// ==========================================
// Reading Passage Generation
// ==========================================

export async function generateReadingPassage(
  lesson: TaeKimLessonContent,
  coreVocabulary?: CoreVocabItem[],
): Promise<ReadingPassage> {
  const client = getClient();

  // Use core vocabulary if provided, otherwise fall back to lesson vocabulary
  const vocabList = coreVocabulary
    ? coreVocabulary
        .slice(0, 10)
        .map((v) => `${v.word} (${v.furigana}) - ${v.definition}`)
        .join("\n")
    : lesson.vocabulary
        .slice(0, 10)
        .map((v) => `${v.japanese} (${v.reading}) - ${v.meaning}`)
        .join("\n");

  const prompt = `Generate a short reading passage for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS TO USE:
${lesson.subPatterns.join(", ")}

VOCABULARY AVAILABLE (use 3-5 of these):
${vocabList}

${TRIAD_FORMAT_INSTRUCTIONS}

${SCENARIO_REQUIREMENTS}

Generate a reading passage with:
1. A brief scenario description (in English)
2. 4-6 Japanese sentences using the grammar patterns and vocabulary
3. Each sentence in triad format (kanji, kana, english)

Output as JSON:
{
  "scenario": "Description of the scenario",
  "sentences": [
    {"kanji": "...", "kana": "...", "english": "..."},
    ...
  ],
  "targetGrammar": ["pattern1", "pattern2"],
  "targetVocabulary": ["vocab_id1", "vocab_id2"]
}`;

  const response = await client.chat.completions.create({
    model: getGenerationModel(),
    max_tokens: 2000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer. Generate authentic, practical reading materials. Output only valid JSON.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate reading passage");
  }

  try {
    // Clean up JSON if wrapped in markdown
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as ReadingPassage;
  } catch (error) {
    console.error("Failed to parse reading passage:", content, error);
    // Return a fallback
    return {
      scenario: "A simple conversation",
      sentences: [
        {
          kanji: "こんにちは。",
          kana: "こんにちは。",
          english: "Hello.",
        },
      ],
      targetGrammar: lesson.subPatterns.slice(0, 2),
      targetVocabulary: [],
    };
  }
}

// ==========================================
// Dialogue Practice Generation
// ==========================================

export async function generateDialoguePractice(
  lesson: TaeKimLessonContent,
  coreVocabulary?: CoreVocabItem[],
): Promise<DialoguePractice> {
  const client = getClient();

  // Use core vocabulary if provided, otherwise fall back to lesson vocabulary
  const vocabList = coreVocabulary
    ? coreVocabulary
        .slice(0, 10)
        .map((v) => `${v.word} (${v.furigana}) - ${v.definition}`)
        .join("\n")
    : lesson.vocabulary
        .slice(0, 10)
        .map((v) => `${v.japanese} (${v.reading}) - ${v.meaning}`)
        .join("\n");

  const prompt = `Generate a dialogue practice for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS TO USE:
${lesson.subPatterns.join(", ")}

VOCABULARY AVAILABLE (use 3-5 of these):
${vocabList}

${TRIAD_FORMAT_INSTRUCTIONS}

${SCENARIO_REQUIREMENTS}

Generate a dialogue with:
1. A scenario description (in English)
2. Two participants (e.g., "Customer", "Shop clerk" or "You", "Friend")
3. 4-6 exchanges that naturally use the grammar patterns
4. Each line in triad format

The student will practice the "You" role, so make those lines especially natural to memorize.

Output as JSON:
{
  "scenario": "Description of the scenario",
  "participants": ["Person A", "Person B"],
  "exchanges": [
    {
      "speaker": "Person A",
      "lines": [{"kanji": "...", "kana": "...", "english": "..."}]
    },
    ...
  ],
  "practiceNotes": "Tips for the student"
}`;

  const response = await client.chat.completions.create({
    model: getGenerationModel(),
    max_tokens: 2000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer. Generate natural, practical dialogues. Output only valid JSON.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate dialogue practice");
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as DialoguePractice;
  } catch (error) {
    console.error("Failed to parse dialogue practice:", content, error);
    return {
      scenario: "Meeting someone new",
      participants: ["You", "New acquaintance"],
      exchanges: [
        {
          speaker: "New acquaintance",
          lines: [{ kanji: "こんにちは。", kana: "こんにちは。", english: "Hello." }],
        },
        {
          speaker: "You",
          lines: [
            {
              kanji: "こんにちは。よろしくお願いします。",
              kana: "こんにちは。よろしくおねがいします。",
              english: "Hello. Nice to meet you.",
            },
          ],
        },
      ],
    };
  }
}

// ==========================================
// Practice Exercises Generation
// ==========================================

export async function generateExercises(
  lesson: TaeKimLessonContent,
  count: number = 5,
  coreVocabulary?: CoreVocabItem[],
): Promise<PracticeExercise[]> {
  const client = getClient();

  // Use core vocabulary if provided, otherwise fall back to lesson vocabulary
  const vocabList = coreVocabulary
    ? coreVocabulary
        .slice(0, 10)
        .map((v) => `${v.word} (${v.furigana}) - ${v.definition}`)
        .join("\n")
    : lesson.vocabulary
        .slice(0, 10)
        .map((v) => `${v.japanese} (${v.reading}) - ${v.meaning}`)
        .join("\n");

  const prompt = `Generate ${count} practice exercises for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS TO TEST:
${lesson.subPatterns.join(", ")}

VOCABULARY AVAILABLE:
${vocabList}

EXERCISE TYPES TO USE:
- multiple_choice: Provide 3-4 options labeled a), b), c), d)
- fill_in_blank: Use (     ) for blanks - student fills in the parentheses
- translation_jp_to_en: Translate Japanese to English
- translation_en_to_jp: Translate English to Japanese

${TRIAD_FORMAT_INSTRUCTIONS}

CRITICAL for fill_in_blank:
- Use parentheses (     ) to mark blanks, NOT underscores
- Example: "昨日(     )を食べました。" - student writes answer in parentheses

Generate ${count} varied exercises. Mix exercise types.

Output as JSON array:
[
  {
    "id": "ex_01",
    "type": "fill_in_blank",
    "prompt": "私(     )学生です。",
    "promptKana": "わたし(     )がくせいです。",
    "expectedAnswers": ["は"],
    "explanation": "は marks the topic of the sentence"
  },
  {
    "id": "ex_02",
    "type": "multiple_choice",
    "prompt": "How do you say 'I am a teacher' politely?",
    "options": ["a) 私は先生だ", "b) 私は先生です", "c) 私が先生です"],
    "expectedAnswers": ["b"],
    "explanation": "です is the polite copula"
  },
  ...
]`;

  const response = await client.chat.completions.create({
    model: getGenerationModel(),
    max_tokens: 3000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language test designer. Create clear, fair exercises. Output only valid JSON array.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate exercises");
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as PracticeExercise[];
  } catch (error) {
    console.error("Failed to parse exercises:", content, error);
    return [
      {
        id: "ex_fallback",
        type: "fill_in_blank",
        prompt: "私(     )日本語を勉強しています。",
        promptKana: "わたし(     )にほんごをべんきょうしています。",
        expectedAnswers: ["は"],
        explanation: "は marks the topic",
      },
    ];
  }
}

// ==========================================
// Writing Exercise Generation
// ==========================================

export async function generateWritingExercise(
  lesson: TaeKimLessonContent,
): Promise<WritingExercise> {
  const client = getClient();

  const prompt = `Generate a writing exercise for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS TO PRACTICE:
${lesson.subPatterns.join(", ")}

${TRIAD_FORMAT_INSTRUCTIONS}

Create a writing exercise where the student must create their own sentence(s) using the grammar patterns.

Types:
- sentence_creation: Create a sentence using specific patterns
- dialogue_completion: Complete a partial dialogue
- free_response: Write about a topic using learned patterns

Output as JSON:
{
  "id": "write_01",
  "type": "sentence_creation",
  "prompt": "Instructions for the student (in English)",
  "targetStructures": ["pattern1", "pattern2"],
  "exampleResponse": {"kanji": "...", "kana": "...", "english": "..."},
  "evaluationCriteria": ["Uses correct grammar", "Natural word order", "Appropriate vocabulary"]
}`;

  const response = await client.chat.completions.create({
    model: getGenerationModel(),
    max_tokens: 1000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer. Create engaging writing prompts. Output only valid JSON.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate writing exercise");
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as WritingExercise;
  } catch (error) {
    console.error("Failed to parse writing exercise:", content, error);
    return {
      id: "write_fallback",
      type: "sentence_creation",
      prompt: `Create a sentence using one of these patterns: ${lesson.subPatterns.slice(0, 2).join(", ")}`,
      targetStructures: lesson.subPatterns.slice(0, 2),
      evaluationCriteria: ["Uses correct grammar", "Makes sense"],
    };
  }
}

// ==========================================
// Vocabulary Generation for Lesson
// ==========================================

export async function generateVocabularyForLesson(
  lesson: TaeKimLesson,
  count: number = 15,
): Promise<VocabularyItem[]> {
  const client = getClient();

  const prompt = `Generate ${count} vocabulary items for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS THIS LESSON COVERS:
${lesson.subPatterns.join(", ")}

Generate vocabulary that:
1. Is commonly used with these grammar patterns
2. Is practical for everyday situations
3. Includes a mix of nouns, verbs, adjectives, and expressions
4. Is appropriate for beginners/intermediate learners

For each word, include:
- An example sentence using one of the lesson's grammar patterns
- The example in triad format (kanji, kana, english)

Output as JSON array:
[
  {
    "id": "v_${lesson.topicId}_01",
    "japanese": "食べる",
    "reading": "taberu",
    "meaning": "to eat",
    "partOfSpeech": "verb (ichidan)",
    "exampleSentence": "毎日野菜を食べます。",
    "exampleReading": "まいにちやさいをたべます。",
    "exampleMeaning": "I eat vegetables every day.",
    "difficulty": 1
  },
  ...
]`;

  const response = await client.chat.completions.create({
    model: getGenerationModel(),
    max_tokens: 4000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer. Generate practical, commonly-used vocabulary. Output only valid JSON array.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate vocabulary");
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as VocabularyItem[];
  } catch (error) {
    console.error("Failed to parse vocabulary:", content, error);
    return [];
  }
}

// ==========================================
// Kanji Generation for Lesson
// ==========================================

export async function generateKanjiForLesson(
  lesson: TaeKimLesson,
  count: number = 5,
): Promise<KanjiItem[]> {
  const client = getClient();

  const prompt = `Generate ${count} kanji characters for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS THIS LESSON COVERS:
${lesson.subPatterns.join(", ")}

Select kanji that:
1. Are commonly seen in words used with these grammar patterns
2. Are appropriate for N5-N4 level
3. Are practical for everyday reading
4. Build on common radicals

For each kanji include:
- Multiple example words showing different readings
- A memory aid or mnemonic

Output as JSON array:
[
  {
    "id": "k_${lesson.topicId}_01",
    "character": "食",
    "readings": {
      "onyomi": ["ショク"],
      "kunyomi": ["た.べる", "く.う"]
    },
    "meanings": ["eat", "food"],
    "strokeCount": 9,
    "examples": [
      {"word": "食べる", "reading": "たべる", "meaning": "to eat"},
      {"word": "食事", "reading": "しょくじ", "meaning": "meal"}
    ],
    "mnemonics": "A person (人) sitting at a table with a cover, ready to eat."
  },
  ...
]`;

  const response = await client.chat.completions.create({
    model: getGenerationModel(),
    max_tokens: 3000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer specializing in kanji education. Generate accurate kanji data with helpful mnemonics. Output only valid JSON array.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Failed to generate kanji");
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as KanjiItem[];
  } catch (error) {
    console.error("Failed to parse kanji:", content, error);
    return [];
  }
}

// ==========================================
// Full Lesson Content Generation
// ==========================================

/**
 * Generate all rich content for a lesson.
 * This is called when starting a new lesson.
 * @param lessonNumber - The lesson number to generate
 * @param chatId - Optional chat ID to get user-specific vocabulary from core_2.3k.csv
 */
export async function generateFullLessonContent(
  lessonNumber: number,
  chatId?: number,
): Promise<TaeKimLessonContent | null> {
  const lesson = getLesson(lessonNumber);
  if (!lesson) {
    return null;
  }

  console.log(`[lesson-generator] Generating content for Lesson ${lessonNumber}: ${lesson.topic}`);

  // Get core vocabulary for this user (next unseen words by frequency)
  let coreVocabulary: CoreVocabItem[] | undefined;
  if (chatId) {
    coreVocabulary = await getNextVocabulary(chatId, 20);
    console.log(
      `[lesson-generator] Using ${coreVocabulary.length} core vocabulary items for user ${chatId}`,
    );
  }

  // Generate kanji (vocabulary comes from core_2.3k.csv now)
  const kanji = await generateKanjiForLesson(lesson, 5);

  // Convert core vocabulary to VocabularyItem format for compatibility
  const vocabulary: VocabularyItem[] = coreVocabulary
    ? coreVocabulary.map((v, i) => ({
        id: `core_${v.rank}`,
        japanese: v.word,
        reading: v.furigana,
        meaning: v.definition,
        partOfSpeech: "core vocabulary",
        exampleSentence: v.exampleJapanese,
        exampleMeaning: v.exampleEnglish,
        difficulty: (Math.floor(i / 7) + 1) as 1 | 2 | 3,
      }))
    : await generateVocabularyForLesson(lesson, 15);

  // Create base lesson content
  const baseContent: TaeKimLessonContent = {
    lessonNumber: lesson.lessonNumber,
    topicId: lesson.topicId,
    topic: lesson.topic,
    subPatterns: lesson.subPatterns,
    grammarExplanation: lesson.description,
    vocabulary,
    kanji,
    learningObjectives: [
      `Understand and use ${lesson.subPatterns.slice(0, 3).join(", ")}`,
      `Apply grammar patterns in real conversations`,
      `Read and understand sentences using these patterns`,
      `Create your own sentences using the grammar`,
    ],
    estimatedMinutes: 30,
  };

  // Generate rich content in parallel, passing core vocabulary
  const [readingPassage, dialoguePractice, practiceExercises, writingExercise] = await Promise.all([
    generateReadingPassage(baseContent, coreVocabulary),
    generateDialoguePractice(baseContent, coreVocabulary),
    generateExercises(baseContent, 5, coreVocabulary),
    generateWritingExercise(baseContent),
  ]);

  // Mark vocabulary as seen for this user
  if (chatId && coreVocabulary) {
    await markVocabularySeen(
      chatId,
      coreVocabulary.map((v) => v.word),
    );
  }

  return {
    ...baseContent,
    readingPassage,
    dialoguePractice,
    practiceExercises,
    writingExercise,
  };
}

/**
 * Generate only the dynamic content (reading, dialogue, exercises, writing).
 * Used when base lesson content already exists.
 * @param baseContent - The base lesson content
 * @param coreVocabulary - Optional core vocabulary to use for content generation
 */
export async function generateDynamicContent(
  baseContent: TaeKimLessonContent,
  coreVocabulary?: CoreVocabItem[],
): Promise<{
  readingPassage: ReadingPassage;
  dialoguePractice: DialoguePractice;
  practiceExercises: PracticeExercise[];
  writingExercise: WritingExercise;
}> {
  const [readingPassage, dialoguePractice, practiceExercises, writingExercise] = await Promise.all([
    generateReadingPassage(baseContent, coreVocabulary),
    generateDialoguePractice(baseContent, coreVocabulary),
    generateExercises(baseContent, 5, coreVocabulary),
    generateWritingExercise(baseContent),
  ]);

  return {
    readingPassage,
    dialoguePractice,
    practiceExercises,
    writingExercise,
  };
}
