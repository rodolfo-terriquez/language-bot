#!/usr/bin/env npx ts-node

/**
 * Generate base lesson content files for Tae Kim curriculum.
 *
 * This script generates vocabulary and kanji lists for each lesson
 * using the LLM. The generated content is saved to data/curriculum/lessons/.
 *
 * Usage:
 *   npx ts-node scripts/generate-curriculum.ts [options]
 *
 * Options:
 *   --lesson N     Generate only lesson N
 *   --from N       Start from lesson N
 *   --to N         End at lesson N
 *   --force        Overwrite existing files
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { loadCurriculum } from "../lib/curriculum.js";
import type { TaeKimLesson, VocabularyItem, KanjiItem } from "../lib/types.js";

// Get OpenRouter client
function getClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    timeout: 120000,
    defaultHeaders: {
      "HTTP-Referer": process.env.BASE_URL || "https://language-bot.vercel.app",
      "X-Title": "Japanese Language Bot - Curriculum Generator",
    },
  });
}

function getModel(): string {
  return process.env.OPENROUTER_MODEL_GENERATION || "anthropic/claude-sonnet-4";
}

// Parse command line arguments
function parseArgs(): { lesson?: number; from?: number; to?: number; force: boolean } {
  const args = process.argv.slice(2);
  const result: { lesson?: number; from?: number; to?: number; force: boolean } = { force: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lesson" && args[i + 1]) {
      result.lesson = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--from" && args[i + 1]) {
      result.from = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--to" && args[i + 1]) {
      result.to = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--force") {
      result.force = true;
    }
  }

  return result;
}

// Generate vocabulary for a lesson
async function generateVocabulary(
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

For each word, include an example sentence using one of the lesson's grammar patterns.

Output as JSON array:
[
  {
    "id": "v_${lesson.topicId}_01",
    "japanese": "食べる",
    "reading": "たべる",
    "meaning": "to eat",
    "partOfSpeech": "verb (ichidan)",
    "exampleSentence": "毎日野菜を食べます。",
    "exampleReading": "まいにちやさいをたべます。",
    "exampleMeaning": "I eat vegetables every day.",
    "difficulty": 1
  }
]

Output ONLY valid JSON, no markdown.`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 4000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer. Generate practical vocabulary. Output only valid JSON array.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    console.error(`Failed to generate vocabulary for lesson ${lesson.lessonNumber}`);
    return [];
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as VocabularyItem[];
  } catch (error) {
    console.error(`Failed to parse vocabulary for lesson ${lesson.lessonNumber}:`, error);
    return [];
  }
}

// Generate kanji for a lesson
async function generateKanji(lesson: TaeKimLesson, count: number = 5): Promise<KanjiItem[]> {
  const client = getClient();

  const prompt = `Generate ${count} kanji characters for a Japanese lesson on "${lesson.topic}".

GRAMMAR PATTERNS THIS LESSON COVERS:
${lesson.subPatterns.join(", ")}

Select kanji that:
1. Are commonly seen in words used with these grammar patterns
2. Are appropriate for N5-N4 level
3. Are practical for everyday reading
4. Build on common radicals

For each kanji include multiple example words and a memory aid.

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
    "mnemonics": "A person sitting at a table with a cover, ready to eat."
  }
]

Output ONLY valid JSON, no markdown.`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 3000,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You are a Japanese language curriculum designer specializing in kanji education. Output only valid JSON array.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    console.error(`Failed to generate kanji for lesson ${lesson.lessonNumber}`);
    return [];
  }

  try {
    let jsonText = content.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonText) as KanjiItem[];
  } catch (error) {
    console.error(`Failed to parse kanji for lesson ${lesson.lessonNumber}:`, error);
    return [];
  }
}

// Generate and save a lesson file
async function generateLessonFile(lesson: TaeKimLesson, force: boolean): Promise<void> {
  const lessonsDir = join(process.cwd(), "data", "curriculum", "lessons");
  const filePath = join(lessonsDir, `lesson-${String(lesson.lessonNumber).padStart(2, "0")}.json`);

  // Check if file exists
  if (existsSync(filePath) && !force) {
    console.log(`Skipping lesson ${lesson.lessonNumber} (file exists, use --force to overwrite)`);
    return;
  }

  console.log(`Generating lesson ${lesson.lessonNumber}: ${lesson.topic}...`);

  // Generate vocabulary and kanji
  const [vocabulary, kanji] = await Promise.all([
    generateVocabulary(lesson, 15),
    generateKanji(lesson, 5),
  ]);

  // Create lesson content
  const lessonContent = {
    lessonNumber: lesson.lessonNumber,
    topicId: lesson.topicId,
    topic: lesson.topic,
    subPatterns: lesson.subPatterns,
    prerequisites: lesson.prerequisites,
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

  // Save to file
  writeFileSync(filePath, JSON.stringify(lessonContent, null, 2));
  console.log(`  Saved to ${filePath}`);
  console.log(`  Vocabulary: ${vocabulary.length} items, Kanji: ${kanji.length} items`);
}

// Main function
async function main() {
  const args = parseArgs();
  const curriculum = loadCurriculum();

  console.log(`Tae Kim Curriculum Generator`);
  console.log(`Total lessons: ${curriculum.totalLessons}`);
  console.log("");

  // Ensure lessons directory exists
  const lessonsDir = join(process.cwd(), "data", "curriculum", "lessons");
  if (!existsSync(lessonsDir)) {
    mkdirSync(lessonsDir, { recursive: true });
    console.log(`Created directory: ${lessonsDir}`);
  }

  // Determine which lessons to generate
  let lessonsToGenerate: TaeKimLesson[] = [];

  if (args.lesson) {
    const lesson = curriculum.lessons.find((l) => l.lessonNumber === args.lesson);
    if (lesson) {
      lessonsToGenerate = [lesson];
    } else {
      console.error(`Lesson ${args.lesson} not found`);
      process.exit(1);
    }
  } else {
    const from = args.from || 1;
    const to = args.to || curriculum.totalLessons;
    lessonsToGenerate = curriculum.lessons.filter(
      (l) => l.lessonNumber >= from && l.lessonNumber <= to,
    );
  }

  console.log(`Generating ${lessonsToGenerate.length} lesson(s)...`);
  console.log("");

  // Generate lessons sequentially to avoid rate limits
  for (const lesson of lessonsToGenerate) {
    try {
      await generateLessonFile(lesson, args.force);
      // Small delay between lessons to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Error generating lesson ${lesson.lessonNumber}:`, error);
    }
  }

  console.log("");
  console.log("Done!");
}

main().catch(console.error);
