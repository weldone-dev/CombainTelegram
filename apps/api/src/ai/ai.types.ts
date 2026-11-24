/** AI capability flags. `policy` additionally allows editing this policy. */
export interface AiCapabilities {
  /** Read accounts, chats, messages, logs, memory, runs. */
  read: boolean;
  /** Send messages as the account. */
  send: boolean;
  /** Allow sending to a chat the account has never talked to. */
  sendUnknown: boolean;
  /** Edit already-sent messages. */
  edit: boolean;
  /** Delete messages (own or in chats where the account may delete). */
  delete: boolean;
  /** Add/remove reactions. */
  react: boolean;
  /** Chat administration (members, bans, invite links). */
  admin: boolean;
  /** Read/write souls and memory. */
  souls: boolean;
  /** Read/write skills. */
  skills: boolean;
  /** Read/write automations. */
  automations: boolean;
  /** Read/write Telegram bots. */
  bots: boolean;
  /** Read/update this permission policy. */
  policy: boolean;
  /** Allow MCP clients at all. */
  mcp: boolean;
}

export type AiCapability = keyof AiCapabilities;

export const DEFAULT_CAPABILITIES: AiCapabilities = {
  read: true,
  send: true,
  sendUnknown: false,
  edit: true,
  delete: false,
  react: true,
  admin: false,
  souls: true,
  skills: true,
  automations: true,
  bots: true,
  policy: false,
  mcp: true,
};

export interface AiPolicyView {
  capabilities: AiCapabilities;
  allowAccountIds: string[];
  allowChatIds: number[];
  blockChatIds: number[];
  dryRun: boolean;
  ownerTgUserIds: string[];
}

/**
 * Voice-note transcription engine. `remote` is the Parakeet HTTP service,
 * `local` is Parakeet TDT 0.6B v3 on this machine, `disabled` turns
 * transcription off. Whisper exists only as an internal last resort and is
 * never an accepted setting.
 */
export type SttEngine = 'remote' | 'local' | 'disabled';

/** Speech-to-text settings shared by the dashboard and `SpeechService`. */
export interface SttSettingsView {
  sttEngine: SttEngine;
  /** Empty means the built-in remote service. */
  sttBaseUrl: string;
  /** Parakeet model id; defaults to `parakeet-tdt-0.6b-v3`. */
  sttModel: string;
  /** `auto` or a locale such as `ru`. */
  sttLanguage: string;
  /** True when a key is stored; the key itself is never returned. */
  hasSttKey: boolean;
}

/** Result of `POST /ai/stt/test`. */
export interface SttTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  /**
   * `remote` = the HTTP `/health` probe; `local` = the local Parakeet model
   * (or the internal whisper fallback) or a disabled engine.
   */
  engine: 'remote' | 'local';
  detail?: string;
}

export interface AiSettingsView extends SttSettingsView {
  provider: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  apiKeySource: 'db' | 'env' | 'opencode' | 'none';
  temperature: number;
  maxSteps: number;
  /** off | low | medium | high; low by default. */
  reasoningEffort: ReasoningEffort;
  dryRun: boolean;
  capabilities: AiCapabilities;
  allowAccountIds: string[];
  allowChatIds: number[];
  blockChatIds: number[];
  ownerTgUserIds: string[];
  source: 'env' | 'database';
  envConfigured: boolean;
  mcp: {
    endpoint: string;
    /** Local single-user app: the token is shown so it can be copied. */
    token: string;
  };
  updatedAt: string | null;
}

export interface AiSettingsUpdate {
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  fastModel?: unknown;
  reasoningEffort?: unknown;
  /** Empty string clears the stored key; undefined keeps it. */
  apiKey?: unknown;
  sttEngine?: unknown;
  /** Empty string falls back to the built-in remote service. */
  sttBaseUrl?: unknown;
  /** Empty means `parakeet-tdt-0.6b-v3`; other values must start with `parakeet`. */
  sttModel?: unknown;
  /** Empty string means `auto`. */
  sttLanguage?: unknown;
  /** String sets the key, null/empty clears it, undefined keeps it. */
  sttApiKey?: unknown;
  temperature?: unknown;
  maxSteps?: unknown;
  dryRun?: unknown;
  capabilities?: unknown;
  allowAccountIds?: unknown;
  allowChatIds?: unknown;
  blockChatIds?: unknown;
  ownerTgUserIds?: unknown;
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface ResolvedProvider {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fastModel: string;
  temperature: number;
  maxSteps: number;
  reasoningEffort: ReasoningEffort;
  dryRun: boolean;
  source: 'env' | 'database';
}

/** OpenAI-compatible tool definition. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | LlmContentPart[];
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmReply {
  content: string;
  /** Provider reasoning/thinking text, when returned. */
  reasoning?: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  model: string;
}

/**
 * Live callbacks for a streaming chat completion. Tool names and arguments
 * never reach them: only the model's reasoning and the final answer.
 */
export interface LlmStreamHandlers {
  /** `reasoning_content` / `reasoning` deltas, as they arrive. */
  onReasoningDelta?: (text: string) => void;
  /** Final answer text deltas, as they arrive. */
  onContentDelta?: (text: string) => void;
}

/** WS payload of `ai.thinking`: start, throttled deltas, then done. */
export interface AiThinkingPayload {
  accountId: string;
  chatId: number;
  runId: string;
  /** `start` opens the bubble; `done` closes it and carries the full text. */
  phase?: 'start' | 'done';
  /** Only on delta events. */
  delta?: string;
  /** Only on `done`. */
  reasoning?: string | null;
}

/** Result of one tool invocation, as shown to the model and to MCP clients. */
export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  /** True when a write tool was simulated because `dryRun` is on. */
  dryRun?: boolean;
}

export interface ToolContext {
  userId: string;
  accountId: string | null;
  chatId: number | null;
  /** ui | mcp | dm | bot | automation | soul-creator | test */
  source: string;
  /** When set, only these chats may be touched by send/edit tools. */
  allowChatIds?: number[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Capability checked before the handler runs. */
  capability: AiCapability;
  /** `write` tools respect `dryRun` and are audited. */
  write?: boolean;
  /** True for tools that change Telegram (subject to `dryRun`). */
  telegramWrite?: boolean;
  /** Only these sources may call the tool. */
  sources?: string[];
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface AgentRunInput {
  userId: string;
  accountId?: string | null;
  chatId?: number | null;
  source: string;
  /** User prompt or the rendered automation prompt. */
  prompt: string;
  /** Images attached to the prompt (vision models only). */
  images?: Array<{ mime: string; data: Buffer }>;
  /** Extra system instructions (surface-specific). */
  systemExtra?: string;
  /** Skill slugs to include in addition to the soul's skills. */
  skillSlugs?: string[];
  /**
   * When true, `skillSlugs` replaces the soul's skill set instead of extending
   * it. Used by the autopilot, where a per-chat override may drop soul skills.
   */
  replaceSoulSkills?: boolean;
  /** Restrict the tool set to these names (used by bots/skills). */
  tools?: string[];
  /** Conversation history to continue (without the system prompt). */
  history?: LlmMessage[];
  model?: string;
  temperature?: number;
  maxSteps?: number;
  /**
   * Streams the model's reasoning text of every LLM round, tool rounds
   * included. Omit it to keep the blocking `chat()` path.
   */
  onReasoningDelta?: (text: string) => void;
  /** Called with the persisted run id before the first LLM round. */
  onRunStart?: (runId: string) => void;
}

export interface AgentTraceEntry {
  step: number;
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
  dryRun?: boolean;
  durationMs: number;
}

export interface AgentRunResult {
  runId: string;
  text: string;
  /** Accumulated reasoning/thinking of the model. */
  reasoning?: string;
  model: string;
  steps: number;
  trace: AgentTraceEntry[];
  usage: LlmUsage;
  error?: string;
}

export interface ToolCallView {
  name: string;
  description: string;
  capability: AiCapability;
  write: boolean;
}

/** Autopilot settings stored as JSON in `Soul.settings`. */
export interface SoulSettings {
  /** Reply in every DM except `excludeChatIds`. */
  allowAllChats: boolean;
  /** Explicit allowlist of private chat ids (Telegram user ids). */
  chatIds: number[];
  excludeChatIds: number[];
  /** Human-like pause before replying, milliseconds. */
  replyDelayMs: number;
  maxPerHour: number;
  maxPerChatPerDay: number;
  typing: boolean;
  /** Typing simulation speed in characters per minute (40–600). */
  typingSpeed: number;
  /** Pass the peer's username and profile bio to the agent. */
  peerProfile: boolean;
  /** Minutes without activity before the account goes offline; 0 disables. */
  presenceIdleMinutes: number;
  /** Extra seconds between coming online and reading the message. */
  presenceReadDelaySeconds: number;
  /** Seconds to wait before showing the account online again. */
  presenceOnlineDelaySeconds: number;
  /** Seconds between the read receipt and the first "typing…". */
  presenceTypingDelaySeconds: number;
}

export const DEFAULT_SOUL_SETTINGS: SoulSettings = {
  allowAllChats: false,
  chatIds: [],
  excludeChatIds: [],
  replyDelayMs: 1200,
  maxPerHour: 12,
  maxPerChatPerDay: 40,
  typing: true,
  typingSpeed: 300,
  peerProfile: true,
  presenceIdleMinutes: 5,
  presenceReadDelaySeconds: 0,
  presenceOnlineDelaySeconds: 5,
  presenceTypingDelaySeconds: 3,
};

export interface SkillView {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  origin: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SoulView {
  id: string;
  accountId: string;
  name: string;
  essence: string;
  tone: string;
  goals: string;
  boundaries: string;
  language: string;
  systemPrompt: string | null;
  mode: 'off' | 'draft' | 'auto';
  settings: SoulSettings;
  model: string | null;
  temperature: number;
  skills: SkillView[];
  createdAt: string;
  updatedAt: string;
}

export interface SoulUpdate {
  name?: unknown;
  essence?: unknown;
  tone?: unknown;
  goals?: unknown;
  boundaries?: unknown;
  language?: unknown;
  systemPrompt?: unknown;
  mode?: unknown;
  settings?: unknown;
  model?: unknown;
  temperature?: unknown;
  skillSlugs?: unknown;
}
