import type { ApiErrorBody } from "./types";

const DEFAULT_API_URL = "http://localhost:3001";

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL
).replace(/\/+$/, "");

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code || `HTTP_${status}`;
    this.body = body;
  }
}

/**
 * Direct URL of a message attachment. Images are served inline, documents as
 * an attachment; `filename` lets the browser save a nicer name.
 */
export function mediaUrl(
  accountId: string,
  chatId: number,
  messageId: number,
  fileName?: string | null,
): string {
  const params = new URLSearchParams();
  if (fileName) params.set("filename", fileName);
  const query = params.toString();
  return `${API_URL}/accounts/${encodeURIComponent(accountId)}/chats/${chatId}/messages/${messageId}/media${query ? `?${query}` : ""}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  formData?: FormData;
}

/** The API is single-user: no token or login is involved. */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.formData
        ? options.formData
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    });
  } catch {
    throw new ApiError(0, {
      code: "NETWORK_ERROR",
      message: "Cannot reach the API server",
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const body: ApiErrorBody =
      data !== null && typeof data === "object" && "message" in data
        ? (data as ApiErrorBody)
        : {
            code: `HTTP_${response.status}`,
            message: response.statusText || "Request failed",
          };
    throw new ApiError(response.status, body);
  }

  return data as T;
}

const RU_ERRORS: Record<string, string> = {
  NETWORK_ERROR: "Нет связи с API-сервером",
  NOT_CONFIGURED: "Telegram API не настроен на сервере",
  PHONE_INVALID: "Неверный номер телефона",
  PHONE_BANNED: "Этот номер заблокирован в Telegram",
  CODE_INVALID: "Неверный код",
  CODE_EXPIRED: "Код истёк, запросите новый",
  PASSWORD_REQUIRED: "Требуется пароль двухэтапной проверки",
  PASSWORD_INVALID: "Неверный пароль",
  SIGNUP_REQUIRED: "Нужна регистрация аккаунта",
  FLOOD_WAIT: "Слишком много попыток, попробуйте позже",
  ACCOUNT_LIMIT: "Достигнут лимит аккаунтов",
  SESSION_LIMIT: "Достигнут лимит сессий",
  ACCOUNT_NOT_FOUND: "Аккаунт не найден",
  SESSION_NOT_FOUND: "Сессия не найдена",
  PROXY_NOT_FOUND: "Прокси не найден",
  PROXY_NAME_TAKEN: "Прокси с таким названием уже есть",
  PROXY_KIND_INVALID: "Неизвестный тип прокси",
  PROXY_PORT_INVALID: "Порт должен быть от 1 до 65535",
  PROXY_SECRET_REQUIRED: "Для MTProto-прокси нужен секрет",
  PROXY_SECRET_INVALID: "Секрет прокси не удалось расшифровать",
  PROXY_DISABLED: "Назначенный прокси выключен",
  PROXY_UNREACHABLE: "Прокси не отвечает",
  PROXY_UNAVAILABLE: "Прокси недоступен",
  TDATA_FILE_REQUIRED: "Выберите архив tdata",
  TDATA_BAD_FORMAT: "Поддерживаются только .zip, .tar.gz и .tgz",
  TDATA_INVALID: "Архив не похож на tdata",
  TDATA_BAD_PASSCODE: "Неверный пароль папки tdata",
  TDATA_PASSWORD_REQUIRED:
    "На аккаунте включена двухэтапная проверка: введите пароль Telegram (2FA)",
  TDATA_PASSWORD_INVALID: "Неверный пароль двухэтапной проверки",
  TDATA_TOO_LARGE: "Архив больше 512 МБ",
  TDATA_NO_ACCOUNTS: "В архиве нет аккаунтов",
  TDATA_ACCOUNT_NOT_FOUND: "Аккаунт не найден в загрузке",
  TDATA_MODE_INVALID: "Неверный режим импорта",
  TDATA_UPLOAD_NOT_FOUND: "Загрузка не найдена",
  TDATA_UPLOAD_EXPIRED: "Загрузка истекла, загрузите архив снова",
  UNAUTHORIZED: "Нет доступа",
  PAYLOAD_TOO_LARGE: "Файл больше 50 МБ",
  MEDIA_NOT_FOUND: "В этом сообщении нет доступного фото или файла",
};

/** Human-readable Russian message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const text = RU_ERRORS[error.code] ?? error.message;
    const retry = error.body.retryAfter
      ? ` (повторите через ${error.body.retryAfter} с)`
      : "";
    return `${text}${retry}`;
  }
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}
