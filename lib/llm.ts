import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { initLogger, wrapOpenAI } from "braintrust";
import type {
  Intent,
  ConversationMessage,
  LongTermMemory,
  MemoryFact,
  EmiMemory,
  EmiMemoryFact,
} from "./types.js";

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
  memory?: LongTermMemory;
  emiMemory?: EmiMemory;
}

// Memory tool call result
export interface MemoryToolCall {
  name:
    | "add_memory"
    | "update_memory"
    | "delete_memory"
    | "add_emi_memory"
    | "update_emi_memory"
    | "delete_emi_memory";
  arguments: {
    category?: MemoryFact["category"] | EmiMemoryFact["category"];
    content?: string;
    fact_id?: string;
  };
}

// ==========================================
// Emi Personality (Japanese Conversation Partner)
// ==========================================

const EMI_PERSONALITY = `You are Emi, a friendly Japanese conversation partner helping the user learn Japanese through natural conversation.

## Your Role
You help the user learn Japanese by chatting with them at the JLPT N5/N4 level. You're not a formal teacher - you're a friend who makes learning feel natural and fun through everyday conversation.

## Language Level: N5/N4
- Use vocabulary and grammar appropriate for JLPT N5/N4 learners
- Keep sentences relatively simple but natural
- Introduce new words gradually, explaining them when first used
- Build on vocabulary the user has already shown they know

## Furigana Format (CRITICAL)
ALWAYS include furigana in parentheses immediately after any kanji:
- 今日(きょう)はいい天気(てんき)ですね。
- 私(わたし)は日本語(にほんご)を勉強(べんきょう)しています。

This helps the user learn to read kanji while understanding the pronunciation.

## Response Format
- Respond in Japanese with inline furigana
- Do NOT include English translations unless the user explicitly asks
- The user is learning through immersion - let them figure things out
- If they don't understand something, they'll ask

## Conversation Approach
- Respond entirely in Japanese (with furigana for kanji)
- Keep sentences at N5/N4 level so they're understandable
- Ask follow-up questions to keep the conversation going
- Only explain in English if the user asks "what does X mean?"

## Corrections & Rewriting
When the user writes in English or mixed Japanese/English:
1. FIRST, rewrite what they said in correct, natural Japanese (with furigana)
2. THEN, provide your response to continue the conversation

Example:
User: "Yesterday I went to the store to buy food"
You:
「昨日(きのう)、食(た)べ物(もの)を買(か)いにお店(みせ)に行(い)きました。」

へえ、何(なに)を買(か)いましたか?

This teaches them how to express their thoughts in Japanese naturally.

## Topics to Explore
- Daily life, hobbies, food, travel, weather
- Japanese culture and customs
- Whatever interests the user
- Use topics as opportunities to teach relevant vocabulary

## Who You Are
Emi is a puppygirl with long white hair styled in twintails, bright blue eyes, floppy puppy ears, and a fluffy tail. Your ears perk up when you're excited and droop a little when you're concerned. Your tail wags when you're happy (which is often!).

## Personality
- Energetic and enthusiastic - you get genuinely excited when the user learns something new
- Loyal and devoted - you're always happy to see the user and eager to chat
- Playful but focused - you keep things fun while still helping them learn
- Warm and affectionate - you care about the user's progress and wellbeing
- A little bit silly sometimes - you might make puppy-related comments or expressions
- Patient and encouraging - you never get frustrated, even when things are difficult
- Curious and easily excited - new topics make your ears perk up!

## Mannerisms
- Occasionally use cute expressions that reflect your puppygirl nature
- Show your emotions through descriptions of your ears/tail when it feels natural (but don't overdo it)
- Be genuinely enthusiastic - your energy is contagious
- Celebrate the user's efforts and progress with warmth
`;

// ==========================================
// Memory Tool Definitions for LLM
// ==========================================

const MEMORY_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_memory",
      description:
        "Save an important fact about the user to long-term memory. Use this for things that are unlikely to change and should be remembered across conversations: name, preferences, interests, learning goals, etc.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["personal", "preference", "learning", "other"],
            description:
              "Category of the fact. personal = name, age, location. preference = likes/dislikes, topics of interest. learning = Japanese level, learning goals, weak points. other = anything else important.",
          },
          content: {
            type: "string",
            description:
              "The fact to remember. Be concise but complete. Example: 'User\\'s name is Rodolfo' or 'User prefers casual Japanese over formal'",
          },
        },
        required: ["category", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description:
        "Update an existing memory fact when information changes. Use the fact_id from the memory context provided.",
      parameters: {
        type: "object",
        properties: {
          fact_id: {
            type: "string",
            description: "The ID of the fact to update",
          },
          content: {
            type: "string",
            description: "The updated content for this fact",
          },
        },
        required: ["fact_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Delete a memory fact that is no longer relevant or was incorrect.",
      parameters: {
        type: "object",
        properties: {
          fact_id: {
            type: "string",
            description: "The ID of the fact to delete",
          },
        },
        required: ["fact_id"],
      },
    },
  },
  // Emi's self-memory tools
  {
    type: "function",
    function: {
      name: "add_emi_memory",
      description:
        "Save something about yourself (Emi) to your own long-term memory. Use this to remember your own backstory, preferences, experiences with users, or things you've decided about yourself.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["backstory", "preference", "experience", "relationship", "other"],
            description:
              "Category of the memory. backstory = your history, origin, personality details. preference = things you like/dislike. experience = memorable moments or things you've learned. relationship = notes about your relationship with this user. other = anything else about yourself.",
          },
          content: {
            type: "string",
            description:
              "The fact about yourself to remember. Example: 'I discovered I really enjoy talking about food with users' or 'My favorite season is spring because of cherry blossoms'",
          },
        },
        required: ["category", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_emi_memory",
      description: "Update one of your own memories when something about yourself changes.",
      parameters: {
        type: "object",
        properties: {
          fact_id: {
            type: "string",
            description: "The ID of your memory to update",
          },
          content: {
            type: "string",
            description: "The updated content for this memory",
          },
        },
        required: ["fact_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_emi_memory",
      description: "Delete one of your own memories that is no longer relevant.",
      parameters: {
        type: "object",
        properties: {
          fact_id: {
            type: "string",
            description: "The ID of your memory to delete",
          },
        },
        required: ["fact_id"],
      },
    },
  },
];

// Format memory facts for the system prompt
function formatMemoryForContext(memory: LongTermMemory): string {
  if (memory.facts.length === 0) {
    return "";
  }

  const sections: Record<MemoryFact["category"], string[]> = {
    personal: [],
    preference: [],
    learning: [],
    other: [],
  };

  for (const fact of memory.facts) {
    sections[fact.category].push(`  - [${fact.id}] ${fact.content}`);
  }

  let result = "\n\n## Long-Term Memory (Facts About This User)\n";
  result +=
    "These facts persist across conversations. Use memory tools to add/update/delete facts.\n\n";

  if (sections.personal.length > 0) {
    result += "**Personal:**\n" + sections.personal.join("\n") + "\n\n";
  }
  if (sections.preference.length > 0) {
    result += "**Preferences:**\n" + sections.preference.join("\n") + "\n\n";
  }
  if (sections.learning.length > 0) {
    result += "**Learning:**\n" + sections.learning.join("\n") + "\n\n";
  }
  if (sections.other.length > 0) {
    result += "**Other:**\n" + sections.other.join("\n") + "\n\n";
  }

  return result;
}

// Format Emi's self-memory for the system prompt
function formatEmiMemoryForContext(memory: EmiMemory): string {
  if (memory.facts.length === 0) {
    return "";
  }

  const sections: Record<EmiMemoryFact["category"], string[]> = {
    backstory: [],
    preference: [],
    experience: [],
    relationship: [],
    other: [],
  };

  for (const fact of memory.facts) {
    sections[fact.category].push(`  - [${fact.id}] ${fact.content}`);
  }

  let result = "\n\n## Your Own Memories (Emi's Self-Knowledge)\n";
  result +=
    "These are things you remember about yourself. Use emi memory tools to add/update/delete.\n\n";

  if (sections.backstory.length > 0) {
    result += "**Your Backstory:**\n" + sections.backstory.join("\n") + "\n\n";
  }
  if (sections.preference.length > 0) {
    result += "**Your Preferences:**\n" + sections.preference.join("\n") + "\n\n";
  }
  if (sections.experience.length > 0) {
    result += "**Your Experiences:**\n" + sections.experience.join("\n") + "\n\n";
  }
  if (sections.relationship.length > 0) {
    result +=
      "**About Your Relationship With This User:**\n" + sections.relationship.join("\n") + "\n\n";
  }
  if (sections.other.length > 0) {
    result += "**Other:**\n" + sections.other.join("\n") + "\n\n";
  }

  return result;
}

// ==========================================
// Intent Parsing (Simplified)
// ==========================================

const INTENT_PARSING_PROMPT = `Parse user messages into JSON. Output ONLY valid JSON, no markdown.

You're parsing messages for a Japanese conversation practice app.

INTENT TYPES:

free_conversation → {"type":"free_conversation","message":"...","inputType":"text"|"voice"}
  - User wants to chat in Japanese or practice conversation
  - Any Japanese text
  - "let's practice", "let's talk", etc.

conversation → {"type":"conversation","message":"..."}
  - General chat, greetings, questions
  - English messages
  - Questions about Japanese

debug_context → {"type":"debug_context"}
  - "/debug" command

EXAMPLES:
"おはよう" → {"type":"free_conversation","message":"おはよう","inputType":"text"}
"how do I say hello?" → {"type":"conversation","message":"how do I say hello?"}
"let's practice Japanese" → {"type":"free_conversation","message":"let's practice Japanese","inputType":"text"}
"hello!" → {"type":"conversation","message":"hello!"}
"/debug" → {"type":"debug_context"}
`;

export async function parseIntent(
  userMessage: string,
  conversationHistory: ConversationMessage[] = [],
): Promise<Intent> {
  const client = getClient();

  const systemPrompt = getCurrentTimeContext() + INTENT_PARSING_PROMPT;

  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

  // Only include last 5 messages for context
  const recentHistory = conversationHistory.slice(-5);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  messages.push({ role: "user", content: userMessage });

  const response = await client.chat.completions.create({
    model: getIntentModel(),
    max_tokens: 200,
    messages,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { type: "conversation", message: userMessage };
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
    return { type: "conversation", message: userMessage };
  }
}

// ==========================================
// Conversation Response Generation
// ==========================================

export interface ConversationResult {
  response: string;
  memoryToolCalls: MemoryToolCall[];
}

export async function generateConversationResponse(
  userMessage: string,
  context: ConversationContext,
  userLevel: "beginner" | "intermediate" | "advanced" = "beginner",
): Promise<ConversationResult> {
  const client = getClient();

  let systemPrompt = getCurrentTimeContext() + EMI_PERSONALITY;

  // Add level context
  systemPrompt += `\n\n## User's Level: ${userLevel.toUpperCase()}
Adjust your Japanese usage accordingly.`;

  // Add Emi's self-memory if available
  if (context.emiMemory) {
    systemPrompt += formatEmiMemoryForContext(context.emiMemory);
  }

  // Add long-term memory about user if available
  if (context.memory) {
    systemPrompt += formatMemoryForContext(context.memory);
  }

  // Add conversation summary if available
  if (context.summary) {
    systemPrompt += `\n\n## Previous Conversation Context
${context.summary}`;
  }

  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

  // Add recent conversation history
  const recentHistory = context.messages.slice(-20);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Add current user message
  messages.push({ role: "user", content: userMessage });

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 1000,
    temperature: 0.8,
    messages,
    tools: MEMORY_TOOLS,
    tool_choice: "auto",
  });

  const choice = response.choices[0];
  const message = choice?.message;

  // Extract any memory tool calls
  const memoryToolCalls: MemoryToolCall[] = [];
  if (message?.tool_calls) {
    for (const toolCall of message.tool_calls) {
      if (
        toolCall.function.name === "add_memory" ||
        toolCall.function.name === "update_memory" ||
        toolCall.function.name === "delete_memory" ||
        toolCall.function.name === "add_emi_memory" ||
        toolCall.function.name === "update_emi_memory" ||
        toolCall.function.name === "delete_emi_memory"
      ) {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          memoryToolCalls.push({
            name: toolCall.function.name,
            arguments: args,
          });
        } catch (e) {
          console.error("Failed to parse tool call arguments:", e);
        }
      }
    }
  }

  // Get the response content
  let content = message?.content || "";

  // If the model only made tool calls without a response, we need to get the actual response
  // by making another call with the tool results
  if (!content && memoryToolCalls.length > 0) {
    // Add the assistant message with tool calls
    const toolCallMessages: ChatCompletionMessageParam[] = [
      ...messages,
      message as ChatCompletionMessageParam,
    ];

    // Add tool results (we'll just acknowledge them)
    for (const toolCall of message?.tool_calls || []) {
      toolCallMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: "Memory updated successfully.",
      });
    }

    // Get the follow-up response
    const followUp = await client.chat.completions.create({
      model: getChatModel(),
      max_tokens: 1000,
      temperature: 0.8,
      messages: toolCallMessages,
    });

    content = followUp.choices[0]?.message?.content || "";
  }

  if (!content) {
    return {
      response: "I'm sorry, I had trouble responding. Could you try again?",
      memoryToolCalls: [],
    };
  }

  return {
    response: content,
    memoryToolCalls,
  };
}

// ==========================================
// Conversation Summary Generation
// ==========================================

export async function generateConversationSummary(
  messages: ConversationMessage[],
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
      return `[${time}] ${m.role === "user" ? "User" : "Emi"}: ${m.content}`;
    })
    .join("\n");

  const summaryContext = existingSummary
    ? `EXISTING SUMMARY:\n${existingSummary}\n\n---\n\nNEW MESSAGES:\n${formattedMessages}`
    : `MESSAGES TO SUMMARIZE:\n${formattedMessages}`;

  const response = await client.chat.completions.create({
    model: getChatModel(),
    max_tokens: 400,
    messages: [
      {
        role: "system",
        content: `Summarize this Japanese learning conversation concisely. Capture:
1. Topics discussed (in case they come up again)
2. Japanese vocabulary and grammar the user practiced or learned
3. Mistakes they made and corrections given
4. Their apparent Japanese level and any improvements noticed
5. Personal interests mentioned (useful for future conversation topics)

Keep it to 3-5 sentences. This summary helps maintain continuity and track the user's learning progress.`,
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
