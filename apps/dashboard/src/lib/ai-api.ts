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
  name: string;
  description: string;
  enabled: boolean;
  triggerType: string;
  trigger: Record<string, unknown>;
  actionType: string;
  action: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
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

export function listRuns(limit = 30): Promise<{ runs: unknown[] }> {
  return apiFetch(`/ai/runs?limit=${limit}`);
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
