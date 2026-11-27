import { defineAgent } from 'eve';
import { configuredModel } from './lib/model/config';

/**
 * Eve is the persona loop; Telegram, SQLite and the actual sending stay in
 * NestJS.
 *
 * The persona model is an OpenAI-compatible endpoint. For local development it
 * reuses the same provider as the Nest dashboard via EVE_LLM_* (see
 * `.env.example`); otherwise EVE_MODEL is treated as a gateway/provider id.
 *
 * The project has exactly one supported persona model: `deepseek-v4.1-flash`.
 * Do not point it at another provider model.
 */

export default defineAgent({
  model: configuredModel(),
  modelContextWindowTokens: 128_000,
  defaultTools: false,
  // The local OpenAI-compatible provider has no AI Gateway metadata. Declare
  // the context window explicitly so Eve does not need a Gateway lookup.
  compaction: { modelContextWindowTokens: 128_000 },
});
