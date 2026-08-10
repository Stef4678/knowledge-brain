/**
 * The six question types. Shared by the thought `question_type` property and
 * the follow-up question groups, so both stay the same six categories.
 */
export const QUESTION_TYPES = [
  "scientific",
  "practical",
  "comparative",
  "historical",
  "causal",
  "critical",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/** The three workflow states a thought can be in. */
export const THOUGHT_STATUSES = ["idea", "in progress", "done"] as const;

export type ThoughtStatus = (typeof THOUGHT_STATUSES)[number];

/** AI providers supported by the chat/ops layer. */
export type Provider = "deepseek" | "openai" | "gemini" | "claude";

/** A thought, mirroring the shape the app returns from db.get_thought. */
export interface Thought {
  /** Note basename (title). Must be unique across active thoughts. */
  id: string;
  title: string;
  content: string;
  source: string;
  question_type: string;
  tags: string[];
  status: string;
  created_at: string;
  updated_at: string;
  parents: Thought[];
  children: Thought[];
  siblings: Thought[];
}

export interface ThoughtLink {
  id: string;
  parent_id: string;
  child_id: string;
  label: string;
}

export interface GraphNode {
  id: string;
  title: string;
  content: string;
  source: string;
  question_type: string;
  tags: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: ThoughtLink[];
}

export interface PluginSettings {
  /** API key for the selected provider (stored in data.json). */
  apiKey: string;
  /** AI provider. */
  provider: Provider;
  /** Chat/JSON model id. */
  model: string;
  /** Chat temperature (0–2). */
  temperature: number;
  /** Reasoning mode (DeepSeek only). */
  thinking: boolean;
  /** Folder inside the vault where new thoughts are created. Empty = vault root. */
  defaultFolder: string;
  /** Graph node spacing factor (breadthfirst layout). */
  graphSpacing: number;
  /** Separator used between words in multi-word tags. */
  tagSeparator: "-" | "_";
  /** Whether AI tag suggestions are enabled. */
  enableAiTags: boolean;
  /** Whether AI status suggestions are enabled. */
  enableAiStatus: boolean;
  /** Show backlinks and siblings in one combined right-sidebar tab. */
  combineSidebarPanes: boolean;
  /** Number of follow-up questions per enabled group. */
  followupCount: number;
  /** Which follow-up question groups are enabled. */
  followupGroups: Record<QuestionType, boolean>;
}

