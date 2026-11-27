import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { gateway, wrapLanguageModel } from 'ai';
import { contextHygieneMiddleware } from './hygiene';

/**
 * The persona model, always wrapped in the context hygiene middleware.
 *
 * The middleware is what keeps reasoning out of Eve's session and puts
 * `temperature`/`maxOutputTokens` on the provider call. If a branch returned a
 * bare model id instead, the harness would resolve it later and the middleware
 * would silently disappear, so every branch resolves a model instance here.
 */

type ModelInstance = Parameters<typeof wrapLanguageModel>[0]['model'];

const HYGIENE_WRAPPED = new WeakSet<object>();

export function applyContextHygiene(model: ModelInstance): ModelInstance {
  const wrapped = wrapLanguageModel({
    model,
    middleware: contextHygieneMiddleware,
    modelId: model.modelId,
    providerId: model.provider,
  });
  HYGIENE_WRAPPED.add(wrapped as object);
  return wrapped;
}

/** True when this model instance came from {@link applyContextHygiene}. */
export function isContextHygieneWrapped(model: unknown): boolean {
  return (
    typeof model === 'object' && model !== null && HYGIENE_WRAPPED.has(model)
  );
}

function providerHeaders(): Record<string, string> {
  const raw =
    process.env.EVE_LLM_HEADERS?.trim() ||
    process.env.AI_EXTRA_HEADERS?.trim() ||
    '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    return {};
  }
}

export function configuredModel(): ModelInstance {
  const baseURL =
    process.env.EVE_LLM_BASE_URL?.trim() ||
    process.env.AI_BASE_URL?.trim() ||
    '';
  const apiKey =
    process.env.EVE_LLM_API_KEY?.trim() ||
    process.env.AI_API_KEY?.trim() ||
    '';
  const model =
    process.env.EVE_LLM_MODEL?.trim() ||
    process.env.AI_MODEL?.trim() ||
    '';
  if (baseURL && apiKey && model) {
    const provider = createOpenAICompatible({
      name: 'combain',
      baseURL,
      apiKey,
      headers: providerHeaders(),
    });
    // Reasoning never reaches Eve's session: the middleware drops it from the
    // response before the harness records the assistant turn, and also strips
    // old reasoning/internal/memory messages from the outgoing prompt.
    return applyContextHygiene(provider(model));
  }

  // A bare `EVE_MODEL` is an AI Gateway model id. Resolve it to a model
  // instance instead of returning the string: a string is resolved by Eve
  // after this module runs, and the middleware would never see the call.
  const id = process.env.EVE_MODEL?.trim() || 'deepseek-v4.1-flash';
  return applyContextHygiene(gateway(id));
}
