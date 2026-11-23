import type { ApiProfile } from 'opentele2';

/**
 * Pure helpers for the TDLib QR bridge POC (`scripts/tdlib-qr-poc.ts`).
 *
 * Nothing here talks to Telegram or TDLib: the script only needs an
 * `ApiProfile`, filesystem paths and the QR link string. Keeping the mapping
 * and parsing rules testable without the native addon is the point.
 */

/** Prefix of the link TDLib exposes in `authorizationStateWaitOtherDeviceConfirmation`. */
export const QR_LOGIN_PREFIX = 'tg://login?token=';

/** Telegram login tokens are short-lived bearer-like values, never huge. */
const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 512;

/**
 * Subset of TDLib's `setTdlibParameters` accepted by `tdlib-native`.
 *
 * TDLib 1.8.70 has no `language_code` parameter anymore: the app language is a
 * client-side option there, so only `system_language_code` comes from the
 * opentele2 profile.
 */
export interface TdlibParameters {
  api_id: number;
  api_hash: string;
  device_model: string;
  system_version: string;
  application_version: string;
  system_language_code: string;
  database_directory: string;
  files_directory: string;
  use_file_database: boolean;
  use_chat_info_database: boolean;
  use_message_database: boolean;
  use_secret_chats: boolean;
}

export interface TdlibDirectories {
  databaseDirectory: string;
  filesDirectory: string;
}

/**
 * Builds TDLib parameters from an opentele2 profile, so the TDLib client
 * presents the exact same official device/application identity as the mtcute
 * session it is bridged into.
 */
export function buildTdlibParameters(
  profile: ApiProfile,
  dirs: TdlibDirectories,
): TdlibParameters {
  if (!profile.apiId || !profile.apiHash) {
    throw new Error('TDLib parameters require a non-empty apiId/apiHash');
  }

  return {
    api_id: profile.apiId,
    api_hash: profile.apiHash,
    device_model: profile.deviceModel,
    system_version: profile.systemVersion,
    application_version: profile.appVersion,
    system_language_code: profile.systemLangCode,
    database_directory: dirs.databaseDirectory,
    files_directory: dirs.filesDirectory,
    use_file_database: false,
    use_chat_info_database: false,
    use_message_database: false,
    use_secret_chats: false,
  };
}

/**
 * Decodes a base64url string (padding optional) and rejects anything that is
 * not canonical base64url. `Buffer.from(value, 'base64url')` alone silently
 * skips invalid characters, which would make a corrupt QR link look valid.
 */
export function decodeBase64Url(value: string): Uint8Array {
  const token = value.trim();
  if (!token) {
    throw new Error('QR login token is empty');
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token)) {
    throw new Error('QR login token is not valid base64url');
  }

  const unpadded = token.replace(/=+$/, '');
  const decoded = Buffer.from(unpadded, 'base64url');
  if (decoded.length === 0) {
    throw new Error('QR login token decodes to zero bytes');
  }
  if (decoded.toString('base64url') !== unpadded) {
    throw new Error('QR login token is not canonical base64url');
  }

  return new Uint8Array(decoded);
}

export interface ParsedQrLoginToken {
  /** Raw token bytes for `auth.acceptLoginToken`. */
  token: Uint8Array;
  /** The base64url part as it appeared in the link. */
  base64url: string;
}

/**
 * Extracts the token from `tg://login?token=<base64url>`.
 *
 * TDLib may refresh the link while waiting, and Telegram may append extra
 * query parameters, so the token is read through the URL parser instead of a
 * string prefix match.
 */
export function parseQrLoginToken(link: string): ParsedQrLoginToken {
  const raw = link?.trim();
  if (!raw) {
    throw new Error('QR login link is empty');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`QR login link is not a URL: ${raw}`);
  }
  if (url.protocol !== 'tg:' || url.hostname !== 'login') {
    throw new Error(`QR login link must start with ${QR_LOGIN_PREFIX}`);
  }

  const base64url = url.searchParams.get('token');
  if (!base64url) {
    throw new Error('QR login link has no token query parameter');
  }

  const token = decodeBase64Url(base64url);
  if (token.length < MIN_TOKEN_BYTES || token.length > MAX_TOKEN_BYTES) {
    throw new Error(
      `QR login token has unexpected length ${token.length} bytes (expected ${MIN_TOKEN_BYTES}..${MAX_TOKEN_BYTES})`,
    );
  }

  return { token, base64url };
}
