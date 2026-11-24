import {
  API_URL,
  ApiError,
  apiFetch,
  errorCodeText,
  errorMessage,
} from "./api";

export type AiCapability =
  | "read"
  | "send"
  | "sendUnknown"
  | "edit"
  | "delete"
  | "react"
  | "admin"
  | "souls"
  | "skills"
  | "automations"
  | "bots"
  | "policy"
  | "mcp";

export type AiCapabilities = Record<AiCapability, boolean>;

export type AiReasoningEffort = "off" | "low" | "medium" | "high";
export type SttEngine = "remote" | "local" | "disabled";

export interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  apiKeySource: "db" | "env" | "opencode" | "none";
  temperature: number;
  maxSteps: number;
  /** off | low | medium | high */
  reasoningEffort: AiReasoningEffort;
  dryRun: boolean;
  capabilities: AiCapabilities;
  allowAccountIds: string[];
  allowChatIds: number[];
  blockChatIds: number[];
  ownerTgUserIds: string[];
  source: "env" | "database";
  envConfigured: boolean;
  mcp: { endpoint: string; token: string };
  updatedAt: string | null;
  sttEngine?: SttEngine;
  sttBaseUrl?: string;
  sttModel?: string | null;
  sttLanguage?: string;
  hasSttKey?: boolean;
}

/** One configurable LLM provider. The API key is never returned. */
export type AiProviderKeySource = "stored" | "opencode" | "env";

export interface AiProviderLimits {
  maxPerHour?: number;
  maxPerDay?: number;
}

export interface AiProviderView {
  id: string;
  name: string;
  kind: string;
  /** Known preset the row was created from, null = custom. */
  preset: string | null;
  keySource: AiProviderKeySource;
  baseUrl: string;
  models: string[];
  defaultModel: string | null;
  reasoningEffort: AiReasoningEffort;
  limits: AiProviderLimits;
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

export interface AiProviderPreset {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  keySource: AiProviderKeySource;
  defaultModel?: string;
  description?: string;
  docsUrl?: string;
}

export interface AiProviderModelInfo {
  id: string;
  label?: string;
  type?: string;
}

export interface AiProviderModelsView {
  models: AiProviderModelInfo[];
  source: "provider" | "stored";
  cached?: boolean;
  fetchedAt?: string;
  error?: string;
}

export interface AiProviderUsageMeter {
  status: string;
  percent: number;
  resetsAt: string | null;
}

export interface AiProviderUsage {
  rolling?: AiProviderUsageMeter;
  weekly?: AiProviderUsageMeter;
  monthly?: AiProviderUsageMeter;
}

export interface AiProviderLimitsView {
  source: "provider" | "manual";
  limits: AiProviderLimits;
  observed?: { lastHour: number; lastDay: number };
  usage?: AiProviderUsage;
  error?: string;
  checkedAt: string;
}

export interface AiProviderLimitsUpdateResult {
  limits: AiProviderLimits;
}

export interface SttTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  engine: "remote" | "local";
  detail?: string;
}

export interface AiProviderTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
}

export interface AiProviderDeleteResult {
  removed: boolean;
  promotedId: string | null;
}

export interface AiProviderImportResult {
  created: boolean;
}

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

export interface SoulSettings {
  allowAllChats: boolean;
  chatIds: number[];
  excludeChatIds: number[];
  replyDelayMs: number;
  maxPerHour: number;
  maxPerChatPerDay: number;
  typing: boolean;
  typingSpeed: number;
  peerProfile: boolean;
  presenceIdleMinutes: number;
  presenceReadDelaySeconds: number;
  presenceOnlineDelaySeconds: number;
  presenceTypingDelaySeconds: number;
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
  mode: "off" | "draft" | "auto";
  settings: SoulSettings;
  model: string | null;
  temperature: number;
  skills: SkillView[];
  createdAt: string;
  updatedAt: string;
}

/** `GET /accounts/:id/ai-settings`: per-account capability overrides. */
export interface AccountAiSettingsView {
  accountId: string;
  /** Only the keys this account overrides; `{}` = fully inherited. */
  permissions: Partial<AiCapabilities>;
  /** `defaults` merged with `permissions`. */
  effective: AiCapabilities;
  /** Global policy capabilities the account inherits by default. */
  defaults: AiCapabilities;
}

export type AiCapabilityPatch = Partial<Record<AiCapability, boolean | null>>;

export interface FactView {
  id: string;
  chatId: number | null;
  kind: string;
  content: string;
  importance: number;
  source: string;
  createdAt: string;
}

export interface TurnView {
  id: string;
  role: string;
  content: string;
  messageId: number | null;
  createdAt: string;
}

export interface MemoryView {
  accountId: string;
  chatId: number | null;
  summary: string;
  facts: FactView[];
  turns: TurnView[];
  stats: { turns: number; facts: number };
  updatedAt: string | null;
}

export type AgentSettings = AiSettings;

export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  input: Record<string, unknown>;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
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

export interface AgentReply {
  runId: string;
  text: string;
  /** Model reasoning / thinking, when the provider returns it. */
  reasoning?: string;
  model: string;
  steps: number;
  trace: AgentTraceEntry[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface ToolInfo {
  name: string;
  description: string;
  capability: AiCapability;
  write: boolean;
}

export interface AutomationView {
  id: string;
  accountId: string | null;
  /** Chat bound to the automation; null = global / not chat-bound. */
  chatId: number | null;
  /** Forum topic or comment thread; 0 = whole chat. */
  threadId: number;
  soulId: string | null;
  /** user | soul | assistant */
  createdBy: string;
  /** IANA zone the wall clock follows; null = server-local. */
  timezone: string | null;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: string;
  trigger: Record<string, unknown>;
  actionType: string;
  action: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  nextDueAt: string | null;
  selfPaused: boolean;
  selfPausedAt: string | null;
  selfPauseReason: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One automation in a chat card, with the latest run status. */
export interface ChatAutomationView extends AutomationView {
  lastRunStatus: string | null;
  lastRunError: string | null;
}

export interface ChatAutomationsView {
  accountId: string;
  chatId: number;
  threadId: number | null;
  automations: ChatAutomationView[];
  summary: {
    total: number;
    active: number;
    paused: number;
    nextDueAt: string | null;
    lastRunAt: string | null;
  };
}

/** `GET /ai/runs` row; `messageIds` are the Telegram bubbles the run sent. */
export interface AgentRunView {
  id: string;
  accountId: string | null;
  chatId: number | null;
  source: string;
  status: string;
  prompt: string;
  output: string | null;
  reasoning: string | null;
  messageIds: number[];
  model: string | null;
  steps: number;
  trace: unknown[];
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AutomationRunView {
  id: string;
  automationId: string;
  status: string;
  input: Record<string, unknown>;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BotView {
  id: string;
  accountId: string | null;
  mode: string;
  username: string | null;
  title: string | null;
  enabled: boolean;
  hasToken: boolean;
  allowedUserIds: string[];
  skills: string[];
  lastError: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const AI_ERRORS: Record<string, string> = {
  INVALID_PROMPT: "Пустой запрос: напишите сообщение агенту",
  INVALID_CHAT: "Нужен корректный chat id",
  INVALID_FACT: "Факт не может быть пустым",
  INVALID_NAME: "Укажите название",
  INVALID_SLUG: "Slug: латиница, цифры, дефис или подчёркивание",
  INVALID_INSTRUCTIONS: "Инструкции скилла не могут быть пустыми",
  INVALID_ACTION: "Неизвестное действие автоматизации",
  SKILL_EXISTS: "Скилл с таким slug уже существует",
  SKILL_NOT_FOUND: "Скилл не найден",
  SYSTEM_SKILL:
    "Встроенный скилл нельзя удалить — выключите или отредактируйте его",
  AUTOMATION_NOT_FOUND: "Автоматизация не найдена",
  BOT_NOT_FOUND: "Бот не найден",
  BOT_TOKEN_MISSING: "У бота ещё нет токена — вставьте токен BotFather",
  BOT_TOKEN_REJECTED: "Telegram не принял токен бота",
  INVALID_BOT_TOKEN: "Токен должен выглядеть как 123456789:AA…",
  PROVIDER_NOT_FOUND: "Провайдер не найден — обновите список",
};

/**
 * Russian message for AI calls. `errorMessage` falls back to the raw code for
 * unmapped codes; AI endpoints either return descriptive Russian text in the
 * body (AI_FAILED) or an English one, so localise the known codes first.
 */
export function aiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const retry = error.body.retryAfter
      ? ` (повторите через ${error.body.retryAfter} с)`
      : "";
    const localised = AI_ERRORS[error.code];
    if (localised) return `${localised}${retry}`;
    const mapped = errorCodeText(error.code);
    const text =
      mapped === error.code && error.body.message ? error.body.message : mapped;
    return `${text}${retry}`;
  }
  return errorMessage(error);
}

export function getAiSettings(): Promise<AiSettings> {
  return apiFetch("/ai/settings", {});
}

export function updateAiSettings(
  body: Record<string, unknown>,
): Promise<AiSettings> {
  return apiFetch("/ai/settings", { method: "PUT", body });
}

/**
 * Partial settings update. The API exposes `PATCH /ai/settings` in newer
 * builds; older ones only accept `PUT`, so fall back without losing the
 * request body.
 */
export async function patchAiSettings(
  body: Record<string, unknown>,
): Promise<AiSettings> {
  try {
    return await apiFetch<AiSettings>("/ai/settings", {
      method: "PATCH",
      body,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 405)
    ) {
      return updateAiSettings(body);
    }
    throw error;
  }
}

export function listAiProviders(): Promise<AiProviderView[]> {
  return apiFetch("/ai/providers");
}

export function listAiProviderPresets(): Promise<AiProviderPreset[]> {
  return apiFetch("/ai/providers/presets");
}

export function getAiProviderModels(id: string): Promise<AiProviderModelsView> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}/models`);
}

export function updateAiProviderModels(
  id: string,
  body: { models: string[]; defaultModel?: string | null },
): Promise<AiProviderView> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}/models`, {
    method: "PUT",
    body,
  });
}

export function getAiProviderLimits(id: string): Promise<AiProviderLimitsView> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}/limits`);
}

export function updateAiProviderLimits(
  id: string,
  body: AiProviderLimits,
): Promise<AiProviderLimitsUpdateResult> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}/limits`, {
    method: "PATCH",
    body,
  });
}

export function createAiProvider(
  body: Record<string, unknown>,
): Promise<AiProviderView> {
  return apiFetch("/ai/providers", { method: "POST", body });
}

export function updateAiProvider(
  id: string,
  body: Record<string, unknown>,
): Promise<AiProviderView> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteAiProvider(id: string): Promise<AiProviderDeleteResult> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function setDefaultAiProvider(id: string): Promise<AiProviderView> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}/default`, {
    method: "POST",
    body: {},
  });
}

export function testAiProvider(id: string): Promise<AiProviderTestResult> {
  return apiFetch(`/ai/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body: {},
  });
}

export function importAiSettings(): Promise<AiProviderImportResult> {
  return apiFetch("/ai/providers/import-settings", {
    method: "POST",
    body: {},
  });
}

export function testStt(): Promise<SttTestResult> {
  return apiFetch("/ai/stt/test", { method: "POST", body: {} });
}

export function updateAiPolicy(
  body: Record<string, unknown>,
): Promise<unknown> {
  return apiFetch("/ai/policy", { method: "PUT", body });
}

export function testAi(): Promise<{
  ok: boolean;
  text: string;
  model: string;
}> {
  return apiFetch("/ai/test", { method: "POST" });
}

export function chatWithAi(body: {
  prompt: string;
  accountId?: string | null;
  chatId?: number | null;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<AgentReply> {
  return apiFetch("/ai/chat", { method: "POST", body });
}

export function getAiTools(): Promise<{ tools: ToolInfo[] }> {
  return apiFetch("/ai/tools");
}

export function listRuns(limit = 30): Promise<{ runs: AgentRunView[] }> {
  return apiFetch(`/ai/runs?limit=${limit}`);
}

/** Runs of one Telegram chat, newest first; used for message reasoning. */
export function listChatRuns(
  accountId: string,
  chatId: number,
  limit = 20,
): Promise<{ runs: AgentRunView[] }> {
  const params = new URLSearchParams({
    accountId,
    chatId: String(chatId),
    limit: String(limit),
  });
  return apiFetch(`/ai/runs?${params.toString()}`);
}

export function getAgentRun(id: string): Promise<AgentRunView> {
  return apiFetch(`/ai/runs/${encodeURIComponent(id)}`);
}

export function listSouls(): Promise<{ souls: SoulView[] }> {
  return apiFetch("/ai/souls");
}

export function getSoul(accountId: string): Promise<SoulView> {
  return apiFetch(`/accounts/${encodeURIComponent(accountId)}/soul`);
}

export function saveSoul(
  accountId: string,
  body: Record<string, unknown>,
): Promise<SoulView> {
  return apiFetch(`/accounts/${encodeURIComponent(accountId)}/soul`, {
    method: "PUT",
    body,
  });
}

export function getMemory(
  accountId: string,
  chatId?: number | null,
): Promise<MemoryView> {
  const query = chatId ? `?chatId=${chatId}` : "";
  return apiFetch(
    `/accounts/${encodeURIComponent(accountId)}/soul/memory${query}`,
  );
}

/** Per-account capability overrides, merged with the global defaults. */
export function getAccountAiSettings(
  accountId: string,
): Promise<AccountAiSettingsView> {
  return apiFetch(`/accounts/${encodeURIComponent(accountId)}/ai-settings`);
}

/**
 * PATCHes only the given account overrides: `false` denies, `true` allows,
 * `null` removes the override and re-inherits the global default.
 */
export function patchAccountAiSettings(
  accountId: string,
  permissions: AiCapabilityPatch,
): Promise<AccountAiSettingsView> {
  return apiFetch(`/accounts/${encodeURIComponent(accountId)}/ai-settings`, {
    method: "PATCH",
    body: { permissions },
  });
}

export function summarizeMemory(
  accountId: string,
  chatId: number,
): Promise<{ summary: string; factsAdded: number; turnsUsed: number }> {
  return apiFetch(
    `/accounts/${encodeURIComponent(accountId)}/soul/memory/summarize`,
    { method: "POST", body: { chatId } },
  );
}

export function addMemoryFact(
  accountId: string,
  body: { chatId?: number | null; content: string; kind?: string },
): Promise<FactView> {
  return apiFetch(
    `/accounts/${encodeURIComponent(accountId)}/soul/memory/facts`,
    { method: "POST", body },
  );
}

export function deleteMemoryFact(
  accountId: string,
  factId: string,
): Promise<{ removed: boolean }> {
  return apiFetch(
    `/accounts/${encodeURIComponent(accountId)}/soul/memory/facts/${encodeURIComponent(factId)}`,
    { method: "DELETE" },
  );
}

export function clearMemoryChat(
  accountId: string,
  chatId: number,
): Promise<{ cleared: boolean }> {
  return apiFetch(
    `/accounts/${encodeURIComponent(accountId)}/soul/memory/chats/${chatId}`,
    { method: "DELETE" },
  );
}

export function listSkills(): Promise<{ skills: SkillView[] }> {
  return apiFetch("/ai/skills");
}

export function createSkill(body: Record<string, unknown>): Promise<SkillView> {
  return apiFetch("/ai/skills", { method: "POST", body });
}

export function updateSkill(
  id: string,
  body: Record<string, unknown>,
): Promise<SkillView> {
  return apiFetch(`/ai/skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteSkill(id: string): Promise<{ removed: boolean }> {
  return apiFetch(`/ai/skills/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listAutomations(): Promise<{ automations: AutomationView[] }> {
  return apiFetch("/ai/automations");
}

/** Chat card: automations bound to one account/chat, plus summary counters. */
export function getChatAutomations(
  accountId: string,
  chatId: number,
  options: { threadId?: number; soulId?: string } = {},
): Promise<ChatAutomationsView> {
  const params = new URLSearchParams();
  if (options.threadId !== undefined) {
    params.set("threadId", String(options.threadId));
  }
  if (options.soulId) params.set("soulId", options.soulId);
  const query = params.toString();
  return apiFetch(
    `/ai/automations/chats/${encodeURIComponent(accountId)}/${chatId}${query ? `?${query}` : ""}`,
  );
}

export function pauseChatAutomations(
  accountId: string,
  chatId: number,
  body: { threadId?: number; soulId?: string; reason?: string | null } = {},
): Promise<{ paused: AutomationView[] }> {
  return apiFetch(
    `/ai/automations/chats/${encodeURIComponent(accountId)}/${chatId}/pause`,
    { method: "POST", body },
  );
}

export function resumeChatAutomations(
  accountId: string,
  chatId: number,
  options: { threadId?: number; soulId?: string } = {},
): Promise<{ resumed: AutomationView[] }> {
  const params = new URLSearchParams();
  if (options.threadId !== undefined) {
    params.set("threadId", String(options.threadId));
  }
  if (options.soulId) params.set("soulId", options.soulId);
  const query = params.toString();
  return apiFetch(
    `/ai/automations/chats/${encodeURIComponent(accountId)}/${chatId}/resume${query ? `?${query}` : ""}`,
    { method: "POST", body: {} },
  );
}

export function resumeAutomation(
  id: string,
): Promise<{ automation: AutomationView | null }> {
  return apiFetch(`/ai/automations/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    body: {},
  });
}

export function createAutomation(
  body: Record<string, unknown>,
): Promise<AutomationView> {
  return apiFetch("/ai/automations", { method: "POST", body });
}

export function updateAutomation(
  id: string,
  body: Record<string, unknown>,
): Promise<AutomationView> {
  return apiFetch(`/ai/automations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteAutomation(id: string): Promise<{ removed: boolean }> {
  return apiFetch(`/ai/automations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function runAutomation(
  id: string,
): Promise<{ runId: string; status: string; output?: string; error?: string }> {
  return apiFetch(`/ai/automations/${encodeURIComponent(id)}/run`, {
    method: "POST",
    body: {},
  });
}

export function getAutomationRuns(
  id: string,
): Promise<{ runs: AutomationRunView[] }> {
  return apiFetch(`/ai/automations/${encodeURIComponent(id)}/runs`);
}

export function listBots(): Promise<{
  bots: BotView[];
  shared: BotView | null;
}> {
  return apiFetch("/ai/bots");
}

export function saveSharedBot(body: Record<string, unknown>): Promise<BotView> {
  return upsertSharedBot(body);
}

export function saveAccountBot(
  accountId: string,
  body: Record<string, unknown>,
): Promise<BotView> {
  return upsertAccountBot(accountId, body);
}

export function upsertSharedBot(
  body: Record<string, unknown>,
): Promise<BotView> {
  return apiFetch("/ai/bots/shared", { method: "PUT", body });
}

export function upsertAccountBot(
  accountId: string,
  body: Record<string, unknown>,
): Promise<BotView> {
  return apiFetch(`/ai/bots/accounts/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    body,
  });
}

export function updateBot(
  id: string,
  body: Record<string, unknown>,
): Promise<BotView> {
  return apiFetch(`/ai/bots/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function checkBot(id: string): Promise<BotView> {
  return apiFetch(`/ai/bots/${encodeURIComponent(id)}/check`, {
    method: "POST",
    body: {},
  });
}

export function deleteBot(id: string): Promise<{ removed: boolean }> {
  return apiFetch(`/ai/bots/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function setBotSkills(
  id: string,
  skillSlugs: string[],
): Promise<BotView> {
  return apiFetch(`/ai/bots/${encodeURIComponent(id)}/skills`, {
    method: "PUT",
    body: { skillSlugs },
  });
}

export function rotateMcpToken(): Promise<{ token: string }> {
  return apiFetch("/ai/mcp/rotate", { method: "POST", body: {} });
}

/**
 * Absolute MCP URL for copy/paste into a client config. Uses the same API
 * origin as every other request (`NEXT_PUBLIC_API_URL`, `localhost:3001` by
 * default), so the dashboard never advertises a dead endpoint.
 */
export function mcpEndpoint(): string {
  return `${API_URL}/mcp`;
}
