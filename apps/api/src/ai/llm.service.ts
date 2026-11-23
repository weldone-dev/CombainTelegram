import { Injectable, Logger } from '@nestjs/common';
import { emitLog } from '../logs/log-sink.js';
import type {
  LlmMessage,
  LlmReply,
  LlmToolCall,
  ToolSchema,
} from './ai.types.js';

export interface LlmRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /** Request timeout, milliseconds. */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: LlmToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Works with OpenAI, DeepSeek, OpenRouter, OpenCode Zen, Ollama and any other
 * `/v1/chat/completions` endpoint. No SDK dependency: one POST, tool calls and
 * usage parsed defensively.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  async chat(request: LlmRequest): Promise<LlmReply> {
    const url = endpoint(request.baseUrl);
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens,
      ...(request.tools && request.tools.length > 0
        ? { tools: request.tools, tool_choice: 'auto' }
        : {}),
    };
    const started = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${request.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(
            request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ),
        });
        const raw = await response.text();
        if (!response.ok) {
          const error = new Error(
            `LLM ${response.status}: ${raw.slice(0, 500)}`,
          );
          // 4xx (except 408/429) is not retryable.
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          ) {
            throw error;
          }
          lastError = error;
          await sleep(400 * attempt);
          continue;
        }
        let parsed: ChatCompletionResponse;
        try {
          parsed = JSON.parse(raw) as ChatCompletionResponse;
        } catch {
          throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 300)}`);
        }
        if (parsed.error?.message) {
          throw new Error(`LLM error: ${parsed.error.message}`);
        }
        const choice = parsed.choices?.[0];
        if (!choice) {
          throw new Error('LLM returned no choices');
        }
        const message = choice.message ?? {};
        const toolCalls = Array.isArray(message.tool_calls)
          ? message.tool_calls.filter(
              (call): call is LlmToolCall =>
                Boolean(call) &&
                typeof call.id === 'string' &&
                typeof call.function?.name === 'string',
            )
          : [];
        const usage = {
          promptTokens:
            parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0,
          completionTokens:
            parsed.usage?.completion_tokens ??
            parsed.usage?.output_tokens ??
            0,
        };
        emitLog({
          level: 'debug',
          source: 'ai',
          action: 'llm.chat',
          message: `LLM ${request.model} answered in ${Date.now() - started} ms`,
          status: 'ok',
          durationMs: Date.now() - started,
          details: {
            model: parsed.model ?? request.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            tools: toolCalls.map((call) => call.function.name),
            attempt,
          },
        });
        return {
          content: typeof message.content === 'string' ? message.content : '',
          toolCalls,
          usage,
          model: parsed.model ?? request.model,
        };
      } catch (error) {
        lastError = error as Error;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(400 * attempt);
          continue;
        }
      }
    }

    emitLog({
      level: 'error',
      source: 'ai',
      action: 'llm.chat',
      message: `LLM request failed: ${lastError?.message ?? 'unknown error'}`,
      status: 'failed',
      durationMs: Date.now() - started,
      details: { model: request.model },
    });
    throw lastError ?? new Error('LLM request failed');
  }

  /** Small helper for one-shot prompts (memory compaction, titles). */
  async complete(
    request: Omit<LlmRequest, 'tools'> & { system?: string },
  ): Promise<string> {
    const messages: LlmMessage[] = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    messages.push(...request.messages);
    const reply = await this.chat({ ...request, messages });
    return reply.content.trim();
  }
}
