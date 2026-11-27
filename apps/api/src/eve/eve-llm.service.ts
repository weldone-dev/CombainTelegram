import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal OpenAI-compatible client for the Eve generators.
 *
 * Nest already owns a provider for the dashboard agent (`AI_*`). Eve reuses it
 * instead of carrying a second credential set: persona packs, daily-life plans
 * and optional embeddings are deterministic-only when the provider is absent,
 * so a missing key never blocks a turn.
 *
 * Nothing here talks to Telegram or Prisma.
 */

export interface EveChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EveChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for `response_format: json_object`. */
  json?: boolean;
  signal?: AbortSignal;
}

export const EVE_LLM_TIMEOUT_MS = 45_000;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function extraHeaders(): Record<string, string> {
  const raw = env('AI_EXTRA_HEADERS');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    return {};
  }
}

@Injectable()
export class EveLlmService {
  private readonly logger = new Logger(EveLlmService.name);

  baseUrl(): string {
    return env('AI_BASE_URL').replace(/\/+$/, '');
  }

  model(): string {
    return env('AI_MODEL') || 'deepseek-chat';
  }

  fastModel(): string {
    return env('AI_FAST_MODEL') || this.model();
  }

  embedModel(): string {
    return env('AI_EMBED_MODEL');
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl() && env('AI_API_KEY'));
  }

  isEmbeddingConfigured(): boolean {
    return this.isConfigured() && Boolean(this.embedModel());
  }

  /**
   * One completion. Returns `null` instead of throwing: every caller has a
   * deterministic fallback and an LLM outage must not break a persona turn.
   */
  async chat(
    messages: EveChatMessage[],
    options: EveChatOptions = {},
  ): Promise<string | null> {
    if (!this.isConfigured() || messages.length === 0) return null;

    const body: Record<string, unknown> = {
      model: options.model ?? this.model(),
      messages,
      temperature: options.temperature ?? 0.9,
      max_tokens: options.maxTokens ?? 1_200,
    };
    if (options.json) body.response_format = { type: 'json_object' };

    try {
      const response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env('AI_API_KEY')}`,
          ...extraHeaders(),
        },
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(EVE_LLM_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(
          `Eve LLM chat failed: HTTP ${response.status} ${await response.text()}`,
        );
        return null;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      return typeof content === 'string' && content.trim()
        ? content.trim()
        : null;
    } catch (error) {
      this.logger.warn(`Eve LLM chat failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Optional embeddings. Providers without an embeddings endpoint (DeepSeek)
   * return `null`, and the caller keeps its lexical scoring.
   */
  async embed(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<number[][] | null> {
    if (!this.isEmbeddingConfigured() || texts.length === 0) return null;
    try {
      const response = await fetch(`${this.baseUrl()}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env('AI_API_KEY')}`,
          ...extraHeaders(),
        },
        body: JSON.stringify({ model: this.embedModel(), input: texts }),
        signal: signal ?? AbortSignal.timeout(EVE_LLM_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(
          `Eve LLM embeddings failed: HTTP ${response.status} ${await response.text()}`,
        );
        return null;
      }
      const data = (await response.json()) as {
        data?: Array<{ embedding?: unknown }>;
      };
      if (!Array.isArray(data.data) || data.data.length !== texts.length) {
        return null;
      }
      const vectors = data.data.map((row) =>
        Array.isArray(row.embedding)
          ? row.embedding.filter((value): value is number => typeof value === 'number')
          : [],
      );
      return vectors.every((vector) => vector.length > 0) ? vectors : null;
    } catch (error) {
      this.logger.warn(
        `Eve LLM embeddings failed: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
