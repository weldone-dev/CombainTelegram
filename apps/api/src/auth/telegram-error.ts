import { HttpStatus } from '@nestjs/common';
import { tl } from '@mtcute/node';
import { apiError } from '../common/api-error.js';
import { emitLog } from '../logs/log-sink.js';
import {
  consumeTelegramErrorLogged,
  currentLogContext,
} from '../logs/log-context.js';

export interface MappedTelegramError {
  code: string;
  message: string;
  status: number;
  retryAfter?: number;
}

interface SimpleMapping {
  code: string;
  message: string;
  status: number;
}

const SIMPLE: Record<string, SimpleMapping> = {
  PHONE_NUMBER_INVALID: {
    code: 'PHONE_INVALID',
    message: 'This phone number is not valid',
    status: HttpStatus.BAD_REQUEST,
  },
  PHONE_NUMBER_BANNED: {
    code: 'PHONE_BANNED',
    message: 'This phone number is banned from Telegram',
    status: HttpStatus.FORBIDDEN,
  },
  PHONE_NUMBER_FLOOD: {
    code: 'PHONE_FLOOD',
    message: 'Too many login attempts for this phone number, try another one',
    status: HttpStatus.TOO_MANY_REQUESTS,
  },
  PHONE_CODE_INVALID: {
    code: 'CODE_INVALID',
    message: 'The confirmation code is invalid',
    status: HttpStatus.BAD_REQUEST,
  },
  PHONE_CODE_EMPTY: {
    code: 'CODE_INVALID',
    message: 'The confirmation code is empty',
    status: HttpStatus.BAD_REQUEST,
  },
  PHONE_CODE_EXPIRED: {
    code: 'CODE_EXPIRED',
    message: 'The confirmation code has expired, request a new one',
    status: HttpStatus.BAD_REQUEST,
  },
  SESSION_PASSWORD_NEEDED: {
    code: 'PASSWORD_REQUIRED',
    message: 'This account is protected with a two-step verification password',
    status: HttpStatus.BAD_REQUEST,
  },
  PASSWORD_HASH_INVALID: {
    code: 'PASSWORD_INVALID',
    message: 'The two-step verification password is invalid',
    status: HttpStatus.BAD_REQUEST,
  },
  SIGN_UP_REQUIRED: {
    code: 'SIGNUP_REQUIRED',
    message: 'This phone number is not registered yet',
    status: HttpStatus.BAD_REQUEST,
  },
  AUTH_TOKEN_EXPIRED: {
    code: 'QR_EXPIRED',
    message: 'The QR login token has expired',
    status: HttpStatus.BAD_REQUEST,
  },
  AUTH_TOKEN_INVALID: {
    code: 'QR_INVALID',
    message: 'The QR login token is invalid',
    status: HttpStatus.BAD_REQUEST,
  },
  // Messaging errors. These used to fall through to TELEGRAM_ERROR/502 with
  // the raw Telegram text, which hid the real reason from the UI.
  CHAT_WRITE_FORBIDDEN: {
    code: 'CHAT_WRITE_FORBIDDEN',
    message: 'You cannot write in this chat',
    status: HttpStatus.FORBIDDEN,
  },
  CHAT_ADMIN_REQUIRED: {
    code: 'CHAT_ADMIN_REQUIRED',
    message: 'Admin rights are required for this action',
    status: HttpStatus.FORBIDDEN,
  },
  CHANNEL_PRIVATE: {
    code: 'CHANNEL_PRIVATE',
    message: 'This channel is private or you are not a member',
    status: HttpStatus.FORBIDDEN,
  },
  CHAT_FORBIDDEN: {
    code: 'CHAT_FORBIDDEN',
    message: 'You are not a member of this chat',
    status: HttpStatus.FORBIDDEN,
  },
  CHAT_RESTRICTED: {
    code: 'CHAT_RESTRICTED',
    message: 'Your account is restricted in this chat',
    status: HttpStatus.FORBIDDEN,
  },
  CHAT_SEND_MEDIA_FORBIDDEN: {
    code: 'CHAT_SEND_MEDIA_FORBIDDEN',
    message: 'Sending media is not allowed in this chat',
    status: HttpStatus.FORBIDDEN,
  },
  USER_BANNED_IN_CHANNEL: {
    code: 'USER_BANNED_IN_CHANNEL',
    message: 'You are banned in this channel',
    status: HttpStatus.FORBIDDEN,
  },
  MESSAGE_ID_INVALID: {
    code: 'MESSAGE_ID_INVALID',
    message: 'This message does not exist or is not accessible',
    status: HttpStatus.BAD_REQUEST,
  },
  MESSAGE_EDIT_TIME_EXPIRED: {
    code: 'MESSAGE_EDIT_TIME_EXPIRED',
    message: 'This message is too old to edit',
    status: HttpStatus.BAD_REQUEST,
  },
  PEER_ID_INVALID: {
    code: 'PEER_ID_INVALID',
    message: 'This chat was not found',
    status: HttpStatus.BAD_REQUEST,
  },
  // Voice transcription (messages.transcribeAudio). Transcription is a
  // Premium feature, and the message must actually be a voice note.
  MSG_VOICE_MISSING: {
    code: 'TRANSCRIPTION_UNAVAILABLE',
    message: 'This message is not a voice note that can be transcribed',
    status: HttpStatus.BAD_REQUEST,
  },
  MSG_VOICE_TOO_LONG: {
    code: 'TRANSCRIPTION_UNAVAILABLE',
    message: 'This voice message is too long to transcribe',
    status: HttpStatus.BAD_REQUEST,
  },
  TRANSCRIPTION_FAILED: {
    code: 'TRANSCRIPTION_FAILED',
    message: 'Telegram could not transcribe this voice message',
    status: HttpStatus.BAD_GATEWAY,
  },
  PREMIUM_ACCOUNT_REQUIRED: {
    code: 'PREMIUM_REQUIRED',
    message: 'Voice transcription requires a Telegram Premium account',
    status: HttpStatus.FORBIDDEN,
  },
};

/** opentele2 flow errors are plain objects with a stable `code`. */
const OT_MAPPING: Record<string, SimpleMapping> = {
  OT_NO_PASSWORD_PROVIDED: {
    code: 'PASSWORD_REQUIRED',
    message: 'This account needs its two-step verification password',
    status: HttpStatus.BAD_REQUEST,
  },
  OT_PASSWORD_INCORRECT: {
    code: 'PASSWORD_INVALID',
    message: 'The two-step verification password is invalid',
    status: HttpStatus.BAD_REQUEST,
  },
  OT_SIGN_UP_REQUIRED: {
    code: 'SIGNUP_REQUIRED',
    message: 'This phone number is not registered yet',
    status: HttpStatus.BAD_REQUEST,
  },
  OT_QR_LOGIN_TIMEOUT: {
    code: 'QR_TIMEOUT',
    message: 'The QR login timed out',
    status: HttpStatus.GATEWAY_TIMEOUT,
  },
  OT_UNSUPPORTED_PASSWORD_ALGORITHM: {
    code: 'PASSWORD_UNSUPPORTED',
    message: 'Unsupported two-step verification algorithm',
    status: HttpStatus.BAD_REQUEST,
  },
  OT_TDATA_LOAD_FAILED: {
    code: 'TDATA_INVALID',
    message: 'The uploaded folder is not a readable Telegram Desktop tdata folder',
    status: HttpStatus.BAD_REQUEST,
  },
};

/**
 * Stable `{ code, message, retryAfter? }` mapping for Telegram/opentele2 errors.
 * Unknown errors become `TELEGRAM_ERROR` (502) instead of leaking internals.
 */
export function mapTelegramError(error: unknown): MappedTelegramError {
  const rpcText = tl.RpcError.is(error) ? error.text : undefined;
  const otCode =
    !rpcText && error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;

  if (rpcText) {
    const flood = /^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)_(\d+)$/.exec(
      rpcText,
    );
    if (flood) {
      return {
        code: 'FLOOD_WAIT',
        message: `Telegram asked to wait ${flood[1]} seconds before retrying`,
        status: HttpStatus.TOO_MANY_REQUESTS,
        retryAfter: Number.parseInt(flood[1], 10),
      };
    }

    const simple = SIMPLE[rpcText];
    if (simple) return { ...simple };

    return {
      code: 'TELEGRAM_ERROR',
      message: `Telegram rejected the request (${rpcText})`,
      status: HttpStatus.BAD_GATEWAY,
    };
  }

  if (typeof otCode === 'string') {
    const mapped = OT_MAPPING[otCode];
    if (mapped) return { ...mapped };

    if (/PASSCODE|PASSWORD/i.test(otCode)) {
      return {
        code: 'TDATA_BAD_PASSCODE',
        message: 'The tdata passcode is wrong or the folder is locked',
        status: HttpStatus.BAD_REQUEST,
      };
    }
  }

  if (error instanceof Error) {
    return {
      code: 'TELEGRAM_ERROR',
      message: error.message,
      status: HttpStatus.BAD_GATEWAY,
    };
  }

  return {
    code: 'TELEGRAM_ERROR',
    message: 'Unknown Telegram error',
    status: HttpStatus.BAD_GATEWAY,
  };
}

/** Throws the mapped HTTP exception; never returns. */
export function raiseTelegramError(error: unknown): never {
  const mapped = mapTelegramError(error);
  const options: { retryAfter?: number } = {};
  if (mapped.retryAfter !== undefined) options.retryAfter = mapped.retryAfter;

  // An instrumented `client.call` already logged this failure with the method
  // name and raw answer; do not write a second, nearly identical entry.
  const alreadyLogged = consumeTelegramErrorLogged();
  const context = currentLogContext();
  const proxyId = context?.proxyId ?? null;
  const telegramMethod = context?.telegramMethod ?? undefined;

  if (!alreadyLogged) {
    // Keep the raw Telegram answer: the mapped HTTP code alone does not tell an
    // agent why Telegram refused (FLOOD_WAIT_42, PEER_ID_INVALID, ...).
    if (tl.RpcError.is(error)) {
      emitLog({
        level: 'error',
        source: 'telegram',
        action: 'telegram.rpc',
        message: `Telegram RPC error: ${error.text}`,
        status: 'failed',
        errorCode: mapped.code,
        telegramError: error.text,
        telegramMethod,
        proxyId,
        telegramResponse: {
          code: error.code,
          text: error.text,
          stack: error.stack?.slice(0, 4000),
        },
        details: { mapped: { ...mapped } },
      });
    } else {
      const asError = error instanceof Error ? error : null;
      const otCode =
        !asError && error && typeof error === 'object'
          ? (error as { code?: unknown }).code
          : undefined;
      emitLog({
        level: 'error',
        source: 'telegram',
        action: 'telegram.call',
        message: `Telegram call failed: ${asError?.message ?? String(otCode ?? error)}`,
        status: 'failed',
        errorCode: mapped.code,
        proxyId,
        telegramMethod,
        telegramError:
          typeof otCode === 'string' ? otCode : (asError?.message ?? undefined),
        telegramResponse: {
          name:
            asError?.name ?? (typeof otCode === 'string' ? otCode : undefined),
          message: asError?.message ?? String(error),
          stack: asError?.stack?.slice(0, 4000),
        },
        details: { mapped: { ...mapped } },
      });
    }
  }

  throw apiError(mapped.code, mapped.message, mapped.status, options);
}
