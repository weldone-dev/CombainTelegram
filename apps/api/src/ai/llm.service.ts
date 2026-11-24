import { Injectable, Logger } from '@nestjs/common';
import { emitLog } from '../logs/log-sink.js';
import type {
  LlmMessage,
  LlmReply,
  LlmStreamHandlers,
  LlmToolCall,
  LlmUsage,
  ReasoningEffort,
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
  /** off | low | medium | high; omitted for `off`. */
  reasoningEffort?: ReasoningEffort;
}

interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: LlmToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: CompletionUsage;
  error?: { message?: string; type?: string; code?: string };
}

/** One SSE `data:` payload of a streamed chat completion. */
interface ChatCompletionChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** OpenCode Go / DeepSeek style. */
      reasoning_content?: string | null;
      /** OpenRouter style. */
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: CompletionUsage;
  error?: { message?: string; type?: string; code?: string };
}

const DEFAULT_TIMEOUT_MS = 45_000;
/** The stream must start producing bytes within this window. */
const FIRST_BYTE_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
/** Bounded copy of a non-SSE body, for the JSON fallback and error text. */
const RAW_BODY_LIMIT = 4000;

/** HTTP failure from the endpoint; 4xx (except 408/429) is not retryable. */
class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/**
 * Transport failure before any text delta. Nothing was shown to the user, so
 * the stream call may fall back to the regular blocking request.
 */
class LlmStreamFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmStreamFallbackError';
  }
}

function extraHeaders(): Record<string, string> {
  const raw = process.env.AI_EXTRA_HEADERS;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...extraHeaders(),
  };
}

/** Request body shared by `chat()` and `chatStream()` so the knobs match. */
function requestBody(
  request: LlmRequest,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens,
    ...(request.reasoningEffort && request.reasoningEffort !== 'off'
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    ...(request.tools && request.tools.length > 0
      ? { tools: request.tools, tool_choice: 'auto' }
      : {}),
    ...(stream
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
  };
}

function usageOf(usage: CompletionUsage | undefined): LlmUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
    completionTokens:
      usage?.completion_tokens ?? usage?.output_tokens ?? 0,
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns a full (non-streamed) completion into the common reply shape. */
function parseCompletion(
  parsed: ChatCompletionResponse,
  fallbackModel: string,
): LlmReply {
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
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning:
      typeof message.reasoning_content === 'string' &&
      message.reasoning_content.trim()
        ? message.reasoning_content.trim()
        : undefined,
    toolCalls,
    usage: usageOf(parsed.usage),
    model: parsed.model ?? fallbackModel,
  };
}

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Works with OpenAI, DeepSeek, OpenRouter, OpenCode Zen, Ollama and any other
 * `/v1/chat/completions` endpoint. No SDK dependency: one POST, tool calls and
 * usage parsed defensively. `chatStream()` adds SSE streaming of the model's
 * reasoning while keeping the exact same reply shape.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  async chat(request: LlmRequest): Promise<LlmReply> {
    const url = endpoint(request.baseUrl);
    const body = requestBody(request, false);
    const started = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // `AbortSignal` alone is not enough when the request goes through a
        // proxy that never answers: race the fetch with a hard timer so the
        // agent loop always makes progress.
        const controller = new AbortController();
        const pending = fetch(url, {
          method: 'POST',
          headers: requestHeaders(request.apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        pending.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`LLM request timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        });
        let response: Response;
        try {
          response = await Promise.race([pending, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
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
        const reply = parseCompletion(parsed, request.model);
        emitLog({
          level: 'debug',
          source: 'ai',
          action: 'llm.chat',
          message: `LLM ${request.model} answered in ${Date.now() - started} ms`,
          status: 'ok',
          durationMs: Date.now() - started,
          details: {
            model: reply.model,
            promptTokens: reply.usage.promptTokens,
            completionTokens: reply.usage.completionTokens,
            tools: reply.toolCalls.map((call) => call.function.name),
            attempt,
          },
        });
        return reply;
      } catch (error) {
        lastError = error as Error;
        emitLog({
          level: 'warn',
          source: 'ai',
          action: 'llm.retry',
          message: `LLM ${request.model} attempt ${attempt}/${MAX_ATTEMPTS} failed after ${Date.now() - started} ms: ${lastError.message}`,
          status: 'failed',
          durationMs: Date.now() - started,
          details: {
            model: request.model,
            attempt,
            error: lastError.message,
          },
        });
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

  /**
   * Same request as `chat()`, but streamed.
   *
   * Parses the SSE body itself: content, `reasoning_content` / `reasoning` and
   * tool-call deltas are accumulated, while reasoning and answer deltas are
   * handed to `handlers` as they arrive. The returned reply is identical to
   * `chat()`'s (content, reasoning, tool calls, usage, model), so the agent
   * loop does not care which path produced it.
   *
   * Retry policy matches `chat()`. A transport failure before any delta falls
   * back to the blocking call, because nothing was shown to the user yet; a
   * failure after deltas is thrown, since partial text cannot be unsent.
   */
  async chatStream(
    request: LlmRequest,
    handlers: LlmStreamHandlers = {},
  ): Promise<LlmReply> {
    const url = endpoint(request.baseUrl);
    const started = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.streamAttempt(
          url,
          request,
          handlers,
          started,
          attempt,
        );
      } catch (error) {
        lastError = error as Error;
        if (lastError instanceof LlmStreamFallbackError) {
          emitLog({
            level: 'warn',
            source: 'ai',
            action: 'llm.stream',
            message: `LLM ${request.model} stream unusable, falling back to the blocking call after ${Date.now() - started} ms: ${lastError.message}`,
            status: 'failed',
            durationMs: Date.now() - started,
            details: {
              model: request.model,
              attempt,
              fallback: true,
              error: lastError.message,
            },
          });
          return this.chat(request);
        }
        emitLog({
          level: 'warn',
          source: 'ai',
          action: 'llm.stream.retry',
          message: `LLM ${request.model} stream attempt ${attempt}/${MAX_ATTEMPTS} failed after ${Date.now() - started} ms: ${lastError.message}`,
          status: 'failed',
          durationMs: Date.now() - started,
          details: {
            model: request.model,
            attempt,
            error: lastError.message,
          },
        });
        if (lastError instanceof LlmHttpError && !lastError.retryable) break;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(400 * attempt);
          continue;
        }
      }
    }

    emitLog({
      level: 'error',
      source: 'ai',
      action: 'llm.stream',
      message: `LLM stream failed: ${lastError?.message ?? 'unknown error'}`,
      status: 'failed',
      durationMs: Date.now() - started,
      details: { model: request.model },
    });
    throw lastError ?? new Error('LLM stream failed');
  }

  /** One streaming attempt: fetch, parse SSE, assemble the reply. */
  private async streamAttempt(
    url: string,
    request: LlmRequest,
    handlers: LlmStreamHandlers,
    started: number,
    attempt: number,
  ): Promise<LlmReply> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const firstByteMs = Math.min(FIRST_BYTE_TIMEOUT_MS, timeoutMs);
    const controller = new AbortController();
    let timedOut: string | null = null;
    let emittedAny = false;
    let deltas = 0;
    let malformed = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    let failFirstByte: ((error: Error) => void) | undefined;
    const firstByteGate = new Promise<never>((_, reject) => {
      failFirstByte = reject;
    });
    firstByteGate.catch(() => undefined);
    let failDeadline: ((error: Error) => void) | undefined;
    const deadlineGate = new Promise<never>((_, reject) => {
      failDeadline = reject;
    });
    deadlineGate.catch(() => undefined);

    let firstByteTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        timedOut = `produced no bytes within ${firstByteMs} ms`;
        controller.abort();
        failFirstByte?.(
          new Error(`LLM stream produced no bytes within ${firstByteMs} ms`),
        );
      },
      firstByteMs,
    );
    const deadlineTimer = setTimeout(() => {
      timedOut = `timed out after ${timeoutMs} ms`;
      controller.abort();
      failDeadline?.(new Error(`LLM stream timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const timeoutError = (): Error => new Error(`LLM stream ${timedOut}`);

    try {
      const pending = fetch(url, {
        method: 'POST',
        headers: requestHeaders(request.apiKey),
        body: JSON.stringify(requestBody(request, true)),
        signal: controller.signal,
      });
      pending.catch(() => undefined);

      let response: Response;
      try {
        response = await Promise.race([pending, firstByteGate, deadlineGate]);
      } catch (error) {
        if (timedOut) throw timeoutError();
        throw new LlmStreamFallbackError(
          `LLM stream request failed: ${(error as Error).message}`,
        );
      }

      if (!response.ok) {
        const raw = await Promise.race([
          response.text().catch(() => ''),
          deadlineGate,
        ]);
        throw new LlmHttpError(
          `LLM ${response.status}: ${raw.slice(0, 500)}`,
          retryableStatus(response.status),
        );
      }

      const contentType = (
        response.headers.get('content-type') ?? ''
      ).toLowerCase();
      // Some deployments ignore `stream: true` and answer with plain JSON.
      // Treat it as a one-shot completion instead of failing the run.
      if (!contentType.includes('text/event-stream')) {
        const raw = await Promise.race([
          response.text().catch(() => ''),
          deadlineGate,
        ]);
        const reply = this.completionFromJson(
          raw,
          request,
          handlers,
          started,
          attempt,
        );
        emittedAny = true;
        return reply;
      }

      if (!response.body) {
        throw new LlmStreamFallbackError('LLM stream returned no body');
      }
      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = '';
      let rawText = '';
      let dataLines: string[] = [];
      let done = false;
      let sawData = false;
      let content = '';
      let reasoning = '';
      let model = request.model;
      let usage: LlmUsage = { promptTokens: 0, completionTokens: 0 };
      const calls = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      const dispatch = (data: string): void => {
        const payload = data.trim();
        if (!payload) return;
        sawData = true;
        if (payload === '[DONE]') {
          done = true;
          return;
        }
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(payload) as ChatCompletionChunk;
        } catch {
          // A malformed line is not worth failing the whole stream for.
          malformed += 1;
          return;
        }
        if (chunk.error?.message) {
          throw new Error(`LLM error: ${chunk.error.message}`);
        }
        if (typeof chunk.model === 'string' && chunk.model) {
          model = chunk.model;
        }
        if (chunk.usage) usage = usageOf(chunk.usage);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return;

        const think =
          typeof delta.reasoning_content === 'string' &&
          delta.reasoning_content
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
        if (think) {
          reasoning += think;
          emittedAny = true;
          deltas += 1;
          handlers.onReasoningDelta?.(think);
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          emittedAny = true;
          deltas += 1;
          handlers.onContentDelta?.(delta.content);
        }
        // Tool calls are accumulated only: names and arguments are never
        // forwarded to the UI callbacks.
        if (Array.isArray(delta.tool_calls)) {
          for (const [position, call] of delta.tool_calls.entries()) {
            if (!call) continue;
            const index =
              typeof call.index === 'number' && Number.isFinite(call.index)
                ? call.index
                : position;
            const accumulator =
              calls.get(index) ?? { id: '', name: '', args: '' };
            if (typeof call.id === 'string' && call.id) {
              accumulator.id = call.id;
            }
            if (typeof call.function?.name === 'string') {
              accumulator.name += call.function.name;
            }
            if (typeof call.function?.arguments === 'string') {
              accumulator.args += call.function.arguments;
            }
            calls.set(index, accumulator);
          }
        }
      };

      const flushEvent = (): void => {
        if (dataLines.length === 0) return;
        const data = dataLines.join('\n');
        dataLines = [];
        dispatch(data);
      };

      const handleLine = (line: string): void => {
        if (line === '') {
          flushEvent();
          return;
        }
        if (line.startsWith(':')) return; // comment / keep-alive
        const colon = line.indexOf(':');
        if (colon < 0) return;
        const field = line.slice(0, colon);
        let value = line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
      };

      const readChunk = async () => {
        try {
          return await Promise.race([
            reader!.read(),
            firstByteGate,
            deadlineGate,
          ]);
        } catch (error) {
          if (timedOut) throw timeoutError();
          const message = `LLM stream read failed: ${(error as Error).message}`;
          if (!emittedAny) throw new LlmStreamFallbackError(message);
          throw new Error(message);
        }
      };

      while (!done) {
        const result = await readChunk();
        if (result.done) break;
        const value = result.value;
        if (!value || value.length === 0) continue;
        if (firstByteTimer) {
          clearTimeout(firstByteTimer);
          firstByteTimer = undefined;
        }
        const text = decoder.decode(value, { stream: true });
        if (rawText.length < RAW_BODY_LIMIT) {
          rawText += text.slice(0, RAW_BODY_LIMIT - rawText.length);
        }
        buffer += text;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          handleLine(line);
          if (done) break;
          newline = buffer.indexOf('\n');
        }
      }

      if (!done) {
        buffer += decoder.decode();
        const tail = buffer.endsWith('\r')
          ? buffer.slice(0, -1)
          : buffer;
        if (tail) handleLine(tail);
        buffer = '';
        flushEvent();
      }

      if (!sawData) {
        // A body that never used SSE framing is either an ignored `stream`
        // flag or a plain JSON error; parse it as a completion.
        const raw = rawText.trim();
        if (raw) {
          const reply = this.completionFromJson(
            raw,
            request,
            handlers,
            started,
            attempt,
          );
          emittedAny = true;
          return reply;
        }
        throw new LlmStreamFallbackError('LLM stream ended without data');
      }

      const toolCalls: LlmToolCall[] = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          type: 'function' as const,
          function: { name: call.name, arguments: call.args },
        }))
        .filter((call) => call.function.name.trim().length > 0);

      const finalReasoning = reasoning.trim()
        ? reasoning.trim()
        : undefined;
      const reply: LlmReply = {
        content,
        reasoning: finalReasoning,
        toolCalls,
        usage,
        model,
      };
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'llm.stream',
        message: `LLM ${model} streamed in ${Date.now() - started} ms`,
        status: 'ok',
        durationMs: Date.now() - started,
        details: {
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          tools: toolCalls.map((call) => call.function.name),
          attempt,
          deltas,
          malformed,
          contentChars: content.length,
          reasoningChars: finalReasoning?.length ?? 0,
        },
      });
      return reply;
    } finally {
      if (firstByteTimer) clearTimeout(firstByteTimer);
      clearTimeout(deadlineTimer);
      if (reader) {
        await reader.cancel().catch(() => undefined);
      }
    }
  }

  /** A completion that arrived as JSON even though streaming was requested. */
  private completionFromJson(
    raw: string,
    request: LlmRequest,
    handlers: LlmStreamHandlers,
    started: number,
    attempt: number,
  ): LlmReply {
    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 300)}`);
    }
    const reply = parseCompletion(parsed, request.model);
    if (reply.reasoning) handlers.onReasoningDelta?.(reply.reasoning);
    if (reply.content) handlers.onContentDelta?.(reply.content);
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'llm.stream',
      message: `LLM ${request.model} answered without SSE in ${Date.now() - started} ms`,
      status: 'ok',
      durationMs: Date.now() - started,
      details: {
        model: reply.model,
        promptTokens: reply.usage.promptTokens,
        completionTokens: reply.usage.completionTokens,
        tools: reply.toolCalls.map((call) => call.function.name),
        attempt,
        streamed: false,
      },
    });
    return reply;
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
