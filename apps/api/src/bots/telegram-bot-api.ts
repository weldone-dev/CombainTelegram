export interface BotApiUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string; title?: string; username?: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
    text?: string;
    caption?: string;
  };
}

export interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class BotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'BotApiError';
  }
}

function baseUrl(): string {
  return (
    process.env.TELEGRAM_BOT_API_BASE?.replace(/\/+$/, '') ??
    'https://api.telegram.org'
  );
}

/**
 * Tiny Telegram Bot API client. Polling is used instead of webhooks because the
 * app runs locally and has no public HTTPS endpoint.
 */
export class TelegramBotApi {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `${baseUrl()}/bot${this.token}/${method}`;
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<T> {
    const response = await fetch(this.url(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: BotApiResponse<T> | null = null;
    try {
      body = (await response.json()) as BotApiResponse<T>;
    } catch {
      body = null;
    }
    if (!response.ok || !body?.ok) {
      const retryAfter =
        typeof body?.description === 'string'
          ? /retry after (\d+)/i.exec(body.description)?.[1]
          : undefined;
      throw new BotApiError(
        body?.description ?? `Bot API ${response.status}`,
        response.status,
        retryAfter ? Number(retryAfter) : undefined,
      );
    }
    return body.result as T;
  }

  async getMe(): Promise<{
    id: number;
    username?: string;
    first_name: string;
    is_bot: boolean;
  }> {
    return this.call('getMe');
  }

  async deleteWebhook(): Promise<boolean> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async getUpdates(offset: number, timeoutSeconds = 25): Promise<BotApiUpdate[]> {
    return this.call(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      (timeoutSeconds + 15) * 1000,
    );
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: { replyToMessageId?: number } = {},
  ): Promise<{ message_id: number }> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(options.replyToMessageId
        ? { reply_to_message_id: options.replyToMessageId }
        : {}),
    });
  }

  async sendChatAction(chatId: number, action = 'typing'): Promise<boolean> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }
}
