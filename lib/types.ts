// ==========================================
// Telegram Types
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
// User Profile (simplified for conversation)
// ==========================================

export interface UserProfile {
  chatId: number;
  displayName: string;
  japaneseLevel: "beginner" | "intermediate" | "advanced";
  preferredTopics: string[]; // Topics user enjoys discussing
  createdAt: number;
  updatedAt: number;
}

// ==========================================
// Conversation History
// ==========================================

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ConversationData {
  messages: ConversationMessage[];
  summary?: string;
  summaryUpdatedAt?: number;
}

// ==========================================
// Long-Term Memory (User)
// ==========================================

export interface LongTermMemory {
  facts: MemoryFact[];
  updatedAt: number;
}

export interface MemoryFact {
  id: string;
  category: "personal" | "preference" | "learning" | "other";
  content: string;
  createdAt: number;
  updatedAt: number;
}

// ==========================================
// Emi's Self-Memory
// ==========================================

export interface EmiMemory {
  facts: EmiMemoryFact[];
  updatedAt: number;
}

export interface EmiMemoryFact {
  id: string;
  category: "backstory" | "preference" | "experience" | "relationship" | "other";
  content: string;
  createdAt: number;
  updatedAt: number;
}

// ==========================================
// Intent Types (simplified)
// ==========================================

export type Intent = ConversationIntent | FreeConversationIntent | DebugContextIntent;

export interface ConversationIntent {
  type: "conversation";
  message: string;
}

export interface FreeConversationIntent {
  type: "free_conversation";
  message: string;
  inputType: "text" | "voice";
}

export interface DebugContextIntent {
  type: "debug_context";
}
