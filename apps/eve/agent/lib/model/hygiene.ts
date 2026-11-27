import type { LanguageModelMiddleware } from 'ai';

/**
 * Context hygiene for the persona model.
 *
 * Three things used to leak into the conversation and kept growing there:
 *
 * - the provider's `reasoning_content` (stored as a reasoning part and re-sent
 *   on every later turn);
 * - `[internal: …]` behavior frames glued to his message;
 * - memory snapshots delivered as user-role messages.
 *
 * Eve keeps whatever the model returned in its session history, and it has no
 * public history-rewrite hook. The model middleware is the narrow place that
 * sees both directions: it strips reasoning before Eve records a response and
 * it removes the old service messages from the prompt on the way in.
 */

const MEMORY_SNAPSHOT = /^stage=.*;\s*interest=.*;\s*trust=/i;
const INTERNAL_LINE = /^\s*\[internal:/i;
const INTERNAL_INLINE = /\[internal:[^\]]*\]/gi;
/** Fragments of an old reasoning transcript, not something he said. */
const REASONING_LINE =
  /^(?:the user|i should|i need|let me|content:|good\s*[—-]|okay,|hmm,|maybe:|now the deleted|the deleted text was|keep it short|avoid lists|no period)/i;

/** Removes `[internal: …]` lines and closed inline fragments. */
export function stripInternalLines(text: string): string {
  return text
    .replace(/^\s*\[internal:.*$/gim, '')
    .replace(INTERNAL_INLINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when a user message is engine data, not words from him. */
export function isServiceUserText(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (MEMORY_SNAPSHOT.test(value)) return true;
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0 && lines.every((line) => INTERNAL_LINE.test(line))) {
    return true;
  }
  // A message made only of old reasoning fragments carries no conversation.
  return lines.length > 0 && lines.every((line) => REASONING_LINE.test(line));
}

export interface PromptPart {
  type: string;
  text?: string;
}

export interface PromptMessage {
  role: string;
  content: string | PromptPart[];
}

/** Drops reasoning and service-only user messages from a provider prompt. */
export function filterPrompt<T extends readonly PromptMessage[]>(prompt: T): T {
  const kept: PromptMessage[] = [];
  // The last user message is the current input. Keep it even when it looks
  // service-shaped: a person may literally type `[internal: …]`, and dropping
  // their message would leave the model with no turn at all.
  const lastUser = prompt.reduce(
    (last, message, index) => (message.role === 'user' ? index : last),
    -1,
  );
  for (const [index, message] of prompt.entries()) {
    const current = index === lastUser;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part) => part.type !== 'reasoning' && part.type !== 'reasoning-file',
      );
      if (content.length === 0) continue;
      kept.push({ ...message, content });
      continue;
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      if (current) {
        kept.push(message);
        continue;
      }
      const content = message.content
        .map((part) =>
          part.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: stripInternalLines(part.text) }
            : part,
        )
        .filter(
          (part) =>
            part.type !== 'text' ||
            (typeof part.text === 'string' && part.text.trim().length > 0),
        );
      if (content.length === 0) continue;
      if (
        content.every(
          (part) => part.type === 'text' && isServiceUserText(part.text ?? ''),
        )
      ) {
        continue;
      }
      kept.push({ ...message, content });
      continue;
    }
    if (message.role === 'user' && typeof message.content === 'string') {
      if (current) {
        kept.push(message);
        continue;
      }
      const text = stripInternalLines(message.content);
      if (!text || isServiceUserText(text)) continue;
      kept.push({ ...message, content: text });
      continue;
    }
    kept.push(message);
  }
  return kept as unknown as T;
}

/** Keeps only final text (and tool traffic) from a streamed response. */
export function filterReasoningStream<T>(
  stream: ReadableStream<T>,
): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const type = (value as { type?: unknown } | null)?.type;
        if (typeof type === 'string' && type.startsWith('reasoning')) continue;
        controller.enqueue(value);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export const CONTEXT_TEMPERATURE = 0.95;
export const CONTEXT_MAX_OUTPUT_TOKENS = 3_500;

/**
 * Eve has no agent-level `temperature`/`maxOutputTokens` field for a directly
 * called model. Both are AI SDK call options, so the same middleware sets them.
 */
export const contextHygieneMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  async transformParams({ params }) {
    return {
      ...params,
      temperature: CONTEXT_TEMPERATURE,
      maxOutputTokens: CONTEXT_MAX_OUTPUT_TOKENS,
      prompt: filterPrompt(
        params.prompt as unknown as PromptMessage[],
      ) as unknown as typeof params.prompt,
    };
  },
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.filter(
        (part) => part.type !== 'reasoning' && part.type !== 'reasoning-file',
      ),
    };
  },
  async wrapStream({ doStream }) {
    const result = await doStream();
    return {
      ...result,
      stream: filterReasoningStream(result.stream),
    };
  },
};
