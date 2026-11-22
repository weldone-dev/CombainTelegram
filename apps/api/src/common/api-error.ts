import { HttpException, HttpStatus } from '@nestjs/common';

/** Shape every auth/accounts error is rendered as. */
export interface ApiErrorBody {
  code: string;
  message: string;
  retryAfter?: number;
  details?: Record<string, unknown>;
}

export interface ApiErrorOptions {
  retryAfter?: number;
  details?: Record<string, unknown>;
}

/**
 * Builds an HttpException whose JSON body is exactly `{ code, message, ... }`.
 *
 * Nest's `BadRequestException` etc. accept a custom body object and return it
 * unchanged, which keeps the public error contract stable across endpoints.
 */
export function apiError(
  code: string,
  message: string,
  status: number = HttpStatus.BAD_REQUEST,
  options: ApiErrorOptions = {},
): HttpException {
  const body: ApiErrorBody = { code, message };
  if (options.retryAfter !== undefined) body.retryAfter = options.retryAfter;
  if (options.details !== undefined) body.details = options.details;
  return new HttpException(body, status);
}

export function notFound(code: string, message: string): HttpException {
  return apiError(code, message, HttpStatus.NOT_FOUND);
}

export function conflict(code: string, message: string): HttpException {
  return apiError(code, message, HttpStatus.CONFLICT);
}

export function forbidden(code: string, message: string): HttpException {
  return apiError(code, message, HttpStatus.FORBIDDEN);
}

export function tooManyRequests(
  code: string,
  message: string,
  retryAfter?: number,
): HttpException {
  return apiError(code, message, HttpStatus.TOO_MANY_REQUESTS, { retryAfter });
}

export function notConfigured(): HttpException {
  return apiError(
    'NOT_CONFIGURED',
    'Telegram API credentials or client profiles are not configured on this server',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
