import { apiError } from './api-error.js';

const DEVICE_ID_MIN = 8;
const DEVICE_ID_MAX = 128;

function invalid(message: string): never {
  throw apiError('VALIDATION_ERROR', message);
}

export function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string') invalid(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) invalid(`${field} is required`);
  if (options.min !== undefined && trimmed.length < options.min) {
    invalid(`${field} must be at least ${options.min} characters`);
  }
  if (options.max !== undefined && trimmed.length > options.max) {
    invalid(`${field} must be at most ${options.max} characters`);
  }
  return trimmed;
}

/** Like `requireString`, but never trims: passwords and passcodes may have spaces. */
export function requireSecret(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${field} is required`);
  }
  if (options.min !== undefined && value.length < options.min) {
    invalid(`${field} must be at least ${options.min} characters`);
  }
  if (options.max !== undefined && value.length > options.max) {
    invalid(`${field} must be at most ${options.max} characters`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  field: string,
  options: { max?: number } = {},
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, options);
}

/**
 * `deviceId` identifies one client slot (PC, phone, ...) of a Telegram account.
 * Reusing it replaces that session key; a new id adds a session.
 */
export function requireDeviceId(value: unknown): string {
  const deviceId = requireString(value, 'deviceId', {
    min: DEVICE_ID_MIN,
    max: DEVICE_ID_MAX,
  });
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId)) {
    invalid(
      'deviceId may only contain letters, digits, dot, underscore, colon and dash',
    );
  }
  return deviceId;
}

/** Accepts `+123456789`, `123456789`, `+1 234 567 89` and normalizes to `+...`. */
export function requirePhone(value: unknown): string {
  const raw = requireString(value, 'phone', { max: 32 });
  const compact = raw.replace(/[\s()-]/g, '');
  if (!/^\+?\d{5,20}$/.test(compact)) {
    throw apiError('PHONE_INVALID', 'phone must be an international number');
  }
  return compact.startsWith('+') ? compact : `+${compact}`;
}

export function parseBoolean(
  value: unknown,
  fallback = false,
): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return invalid('expected a boolean value');
}
