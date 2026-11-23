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

export interface AiSettingsView {
  provider: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  apiKeySource: 'db' | 'env' | 'none';
  temperature: number;
  maxSteps: number;
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
  /** Empty string clears the stored key; undefined keeps it. */
  apiKey?: unknown;
  temperature?: unknown;
  maxSteps?: unknown;
  dryRun?: unknown;
  capabilities?: unknown;
  allowAccountIds?: unknown;
  allowChatIds?: unknown;
  blockChatIds?: unknown;
  ownerTgUserIds?: unknown;
}

export interface ResolvedProvider {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  fastModel: string;
  temperature: number;
  maxSteps: number;
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

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  model: string;
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
  /** Extra system instructions (surface-specific). */
  systemExtra?: string;
  /** Skill slugs to include in addition to the soul's skills. */
  skillSlugs?: string[];
  /** Restrict the tool set to these names (used by bots/skills). */
  tools?: string[];
  /** Conversation history to continue (without the system prompt). */
  history?: LlmMessage[];
  model?: string;
  temperature?: number;
  maxSteps?: number;
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
}

export const DEFAULT_SOUL_SETTINGS: SoulSettings = {
  allowAllChats: false,
  chatIds: [],
  excludeChatIds: [],
  replyDelayMs: 1200,
  maxPerHour: 12,
  maxPerChatPerDay: 40,
  typing: true,
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
