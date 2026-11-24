import { DEFAULT_CAPABILITIES } from '../ai/ai.types.js';
import type { AiCapabilities, AiCapability } from '../ai/ai.types.js';

/** Only the keys the owner actually overrode; missing keys inherit global. */
export type AiCapabilityOverrides = Partial<Record<AiCapability, boolean>>;

/** A fresh copy of the compiled-in defaults. */
export function aiPolicyDefaults(): AiCapabilities {
  return { ...DEFAULT_CAPABILITIES };
}

/**
 * Per-key merge: an override wins only for the keys it actually sets, every
 * other capability keeps the global value. Unknown keys never reach here
 * (`parseOverrides`/`parseOverridePatch` filter them).
 */
export function mergeCapabilities(
  defaults: AiCapabilities,
  overrides: AiCapabilityOverrides,
): AiCapabilities {
  const effective: AiCapabilities = { ...defaults };
  for (const key of Object.keys(defaults) as AiCapability[]) {
    const value = overrides[key];
    if (typeof value === 'boolean') effective[key] = value;
  }
  return effective;
}
