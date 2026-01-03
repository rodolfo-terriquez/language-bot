import type { LessonChecklist, LessonChecklistItem, SyllabusDay } from "./types.js";
import { getSyllabusDay } from "./syllabus.js";
import { getReviewCandidates } from "./redis.js";

// Configuration for adaptive learning
const MAX_REVIEW_ITEMS = 5;

/**
 * Generate a lesson checklist from the syllabus for a given day.
 * The checklist tracks teaching and practice items for the LLM to follow.
 * For Day 2+, includes review items from previous days based on spaced repetition.
 */
export async function generateChecklist(
  chatId: number,
  dayNumber: number,
): Promise<LessonChecklist | null> {
  const syllabus = await getSyllabusDay(dayNumber);
  if (!syllabus) return null;

  const items: LessonChecklistItem[] = [];
  let itemCounter = 0;

  // Add review items first (only for Day 2+)
  if (dayNumber > 1) {
    const reviewCandidates = await getReviewCandidates(chatId, dayNumber, MAX_REVIEW_ITEMS);

    for (const candidate of reviewCandidates) {
      // Fetch display text from the source day's syllabus
      const sourceDay = await getSyllabusDay(candidate.item.dayIntroduced);
      let displayText = candidate.item.itemId;

      if (sourceDay) {
        switch (candidate.item.itemType) {
          case "vocabulary": {
            const v = sourceDay.vocabulary.find((x) => x.id === candidate.item.itemId);
            if (v) displayText = `${v.japanese} (${v.reading}) - ${v.meaning}`;
            break;
          }
          case "grammar": {
            const g = sourceDay.grammar.find((x) => x.id === candidate.item.itemId);
            if (g) displayText = `${g.pattern} - ${g.meaning}`;
            break;
          }
          case "kanji": {
            const k = sourceDay.kanji.find((x) => x.id === candidate.item.itemId);
            if (k) displayText = `${k.character} - ${k.meanings.join(", ")}`;
            break;
          }
        }
      }

      items.push({
        id: `item_${String(++itemCounter).padStart(3, "0")}`,
        type: "review",
        status: "pending",
        contentType: candidate.item.itemType,
        contentId: candidate.item.itemId,
        displayText: `[Review from Day ${candidate.item.dayIntroduced}] ${displayText}`,
        sourceDayNumber: candidate.item.dayIntroduced,
      });
    }
  }

  // Add vocabulary teaching items
  for (const vocab of syllabus.vocabulary) {
    items.push({
      id: `item_${String(++itemCounter).padStart(3, "0")}`,
      type: "teach",
      status: "pending",
      contentType: "vocabulary",
      contentId: vocab.id,
      displayText: `${vocab.japanese} (${vocab.reading}) - ${vocab.meaning}`,
    });
  }

  // Add vocabulary practice if there are vocab items
  if (syllabus.vocabulary.length > 0) {
    items.push({
      id: `item_${String(++itemCounter).padStart(3, "0")}`,
      type: "practice",
      status: "pending",
      contentType: "vocabulary",
      contentId: "vocab_review",
      displayText: "Vocabulary review quiz",
    });
  }

  // Add grammar teaching items
  for (const grammar of syllabus.grammar) {
    items.push({
      id: `item_${String(++itemCounter).padStart(3, "0")}`,
      type: "teach",
      status: "pending",
      contentType: "grammar",
      contentId: grammar.id,
      displayText: `${grammar.pattern} - ${grammar.meaning}`,
    });
  }

  // Add grammar practice if there are grammar items
  if (syllabus.grammar.length > 0) {
    items.push({
      id: `item_${String(++itemCounter).padStart(3, "0")}`,
      type: "practice",
      status: "pending",
      contentType: "grammar",
      contentId: "grammar_review",
      displayText: "Grammar practice",
    });
  }

  // Add kanji teaching items
  for (const kanji of syllabus.kanji) {
    const readings = [
      ...kanji.readings.onyomi.map((r) => `音: ${r}`),
      ...kanji.readings.kunyomi.map((r) => `訓: ${r}`),
    ].join(", ");
    items.push({
      id: `item_${String(++itemCounter).padStart(3, "0")}`,
      type: "teach",
      status: "pending",
      contentType: "kanji",
      contentId: kanji.id,
      displayText: `${kanji.character} (${readings}) - ${kanji.meanings.join(", ")}`,
    });
  }

  // Add kanji practice if there are kanji items
  if (syllabus.kanji.length > 0) {
    items.push({
      id: `item_${String(++itemCounter).padStart(3, "0")}`,
      type: "practice",
      status: "pending",
      contentType: "kanji",
      contentId: "kanji_review",
      displayText: "Kanji review",
    });
  }

  // Set first item as current
  if (items.length > 0) {
    items[0].status = "current";
  }

  const now = Date.now();
  return {
    chatId,
    dayNumber,
    title: syllabus.title,
    items,
    currentIndex: 0,
    completedCount: 0,
    totalCount: items.length,
    createdAt: now,
    lastUpdated: now,
  };
}

/**
 * Render the checklist as a string for the LLM context.
 * Shows completed items with [✓], current item with ← CURRENT marker.
 */
export function renderChecklistForLLM(checklist: LessonChecklist): string {
  let output = `[Lesson Checklist - Day ${checklist.dayNumber}: ${checklist.title}]\n`;

  // Show review item count if any
  const reviewCount = checklist.items.filter((i) => i.type === "review").length;
  if (reviewCount > 0) {
    output += `[${reviewCount} review item${reviewCount > 1 ? "s" : ""} from previous days]\n`;
  }

  for (const item of checklist.items) {
    const marker = item.status === "complete" ? "[✓]" : "[ ]";
    const current = item.status === "current" ? " ← CURRENT" : "";
    const type = item.type.toUpperCase();
    const inserted = item.isInserted ? " (clarification)" : "";

    output += `${marker} ${type}: ${item.displayText}${inserted}${current}\n`;
  }

  output += `[End of checklist - ${checklist.completedCount}/${checklist.totalCount} complete]`;
  return output;
}

/**
 * Advance the checklist: mark current item complete and move to next.
 * Returns the updated checklist and the newly current item (if any).
 */
export function advanceChecklist(checklist: LessonChecklist): {
  checklist: LessonChecklist;
  newCurrentItem: LessonChecklistItem | null;
  isComplete: boolean;
} {
  // Mark current item complete
  if (checklist.currentIndex < checklist.items.length) {
    checklist.items[checklist.currentIndex].status = "complete";
    checklist.completedCount++;
  }

  // Move to next item
  checklist.currentIndex++;
  checklist.lastUpdated = Date.now();

  // Check if we're done
  if (checklist.currentIndex >= checklist.items.length) {
    return {
      checklist,
      newCurrentItem: null,
      isComplete: true,
    };
  }

  // Set new current item
  checklist.items[checklist.currentIndex].status = "current";

  return {
    checklist,
    newCurrentItem: checklist.items[checklist.currentIndex],
    isComplete: false,
  };
}

/**
 * Insert a clarification item after the current item.
 * This allows the LLM to add extra teaching when the user is confused.
 */
export function insertClarification(
  checklist: LessonChecklist,
  content: string,
): LessonChecklist {
  const insertIndex = checklist.currentIndex + 1;

  // Generate new item ID
  const maxId = Math.max(
    ...checklist.items.map((item) => parseInt(item.id.replace("item_", ""), 10)),
  );

  const clarifyItem: LessonChecklistItem = {
    id: `item_${String(maxId + 1).padStart(3, "0")}`,
    type: "clarify",
    status: "pending",
    contentType: checklist.items[checklist.currentIndex]?.contentType || "vocabulary",
    contentId: "clarify",
    displayText: content,
    isInserted: true,
    insertedContent: content,
  };

  // Insert after current item
  checklist.items.splice(insertIndex, 0, clarifyItem);
  checklist.totalCount = checklist.items.length;
  checklist.lastUpdated = Date.now();

  return checklist;
}

/**
 * Get the current item from the checklist.
 */
export function getCurrentItem(checklist: LessonChecklist): LessonChecklistItem | null {
  if (checklist.currentIndex >= checklist.items.length) {
    return null;
  }
  return checklist.items[checklist.currentIndex];
}

/**
 * Check if the checklist is complete.
 */
export function isChecklistComplete(checklist: LessonChecklist): boolean {
  return checklist.currentIndex >= checklist.items.length;
}

/**
 * Get progress percentage.
 */
export function getProgressPercentage(checklist: LessonChecklist): number {
  if (checklist.totalCount === 0) return 100;
  return Math.round((checklist.completedCount / checklist.totalCount) * 100);
}

/**
 * Get the syllabus content for the current item.
 * This provides the full content from the syllabus for teaching.
 * For review items, loads content from the source day instead of current day.
 */
export async function getCurrentItemContent(
  checklist: LessonChecklist,
): Promise<{
  item: LessonChecklistItem;
  vocabularyItem?: SyllabusDay["vocabulary"][0];
  grammarPattern?: SyllabusDay["grammar"][0];
  kanjiItem?: SyllabusDay["kanji"][0];
} | null> {
  const currentItem = getCurrentItem(checklist);
  if (!currentItem) return null;

  // For practice or clarify items, just return the item
  if (currentItem.type === "practice" || currentItem.type === "clarify") {
    return { item: currentItem };
  }

  // Determine which day to load content from:
  // - For review items, use the source day
  // - For teach items, use the current lesson day
  const contentDayNumber =
    currentItem.type === "review" && currentItem.sourceDayNumber
      ? currentItem.sourceDayNumber
      : checklist.dayNumber;

  // Load syllabus to get full content
  const syllabus = await getSyllabusDay(contentDayNumber);
  if (!syllabus) return { item: currentItem };

  const result: {
    item: LessonChecklistItem;
    vocabularyItem?: SyllabusDay["vocabulary"][0];
    grammarPattern?: SyllabusDay["grammar"][0];
    kanjiItem?: SyllabusDay["kanji"][0];
  } = { item: currentItem };

  switch (currentItem.contentType) {
    case "vocabulary":
      result.vocabularyItem = syllabus.vocabulary.find((v) => v.id === currentItem.contentId);
      break;
    case "grammar":
      result.grammarPattern = syllabus.grammar.find((g) => g.id === currentItem.contentId);
      break;
    case "kanji":
      result.kanjiItem = syllabus.kanji.find((k) => k.id === currentItem.contentId);
      break;
  }

  return result;
}
