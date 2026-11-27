/**
 * Communication presets. They describe *how* she texts, independently of her
 * character documents: notification priority, message rhythm, initiative and
 * how much of her own life she shares.
 */

import type {
  CommunicationProfile,
  InitiativeLevel,
  LifeSharingLevel,
  MessageStyle,
  NotificationMode,
  PersonaConfig,
} from './types';
import { clampInt } from './time';

export const DEFAULT_COMMUNICATION: CommunicationProfile = {
  notifications: 'normal',
  messageStyle: 'balanced',
  initiative: 'medium',
  lifeSharing: 'medium',
};

const NOTIFICATION_MODES: NotificationMode[] = ['muted', 'normal', 'priority'];
const MESSAGE_STYLES: MessageStyle[] = ['one-liners', 'balanced', 'bursty', 'longform'];
const INITIATIVE_LEVELS: InitiativeLevel[] = ['low', 'medium', 'high'];
const LIFE_SHARING_LEVELS: LifeSharingLevel[] = ['low', 'medium', 'high'];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function normalizeCommunicationProfile(
  config: Pick<PersonaConfig, 'communication'> & { vibe?: string },
): CommunicationProfile {
  const raw = config.communication ?? {};
  return {
    notifications: pick(
      raw.notifications,
      NOTIFICATION_MODES,
      DEFAULT_COMMUNICATION.notifications,
    ),
    messageStyle: pick(raw.messageStyle, MESSAGE_STYLES, DEFAULT_COMMUNICATION.messageStyle),
    initiative: pick(raw.initiative, INITIATIVE_LEVELS, DEFAULT_COMMUNICATION.initiative),
    lifeSharing: pick(raw.lifeSharing, LIFE_SHARING_LEVELS, DEFAULT_COMMUNICATION.lifeSharing),
  };
}

export function normalizeIgnoreTendency(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 35;
  return clampInt(n, 0, 100);
}

const STYLE_RU: Record<MessageStyle, string> = {
  'one-liners': 'короткие одиночные реплики, часто одно слово',
  balanced: 'обычные короткие сообщения на одну-две мысли',
  bursty: 'несколько быстрых пузырей подряд, как будто печатает и не останавливается',
  longform: 'редко, но длиннее: может написать абзац, если тема зацепила',
};

const INITIATIVE_RU: Record<InitiativeLevel, string> = {
  low: 'сама почти не пишет первой, ждёт его шага',
  medium: 'иногда пишет первой, если есть повод',
  high: 'часто пишет первой и легко предлагает созвониться или встретиться',
};

const LIFE_RU: Record<LifeSharingLevel, string> = {
  low: 'о своей жизни рассказывает мало, только если спросят',
  medium: 'делится событиями дня в меру, без потока',
  high: 'охотно рассказывает, что у неё происходит, и сама спрашивает о нём',
};

const NOTIFICATIONS_RU: Record<NotificationMode, string> = {
  muted: 'уведомления в основном на беззвучном, заходит редко',
  normal: 'обычный режим уведомлений',
  priority: 'его сообщения у неё в приоритете: замечает их быстрее остальных',
};

/** Compact Russian block for the system prompt. */
export function communicationPromptFragment(profile: CommunicationProfile): string {
  return [
    'как ты пишешь:',
    `- ритм: ${STYLE_RU[profile.messageStyle]}`,
    `- инициатива: ${INITIATIVE_RU[profile.initiative]}`,
    `- своя жизнь: ${LIFE_RU[profile.lifeSharing]}`,
    `- уведомления: ${NOTIFICATIONS_RU[profile.notifications]}`,
  ].join('\n');
}

/** Instruction about how easily she ignores messages (0..100). */
export function ignoreTendencyPrompt(tendency: number): string {
  const value = normalizeIgnoreTendency(tendency);
  const band =
    value <= 20
      ? 'ты почти всегда отвечаешь: молчание для тебя — редкость'
      : value <= 45
        ? 'ты обычно отвечаешь, но можешь пропустить скучное или неуместное'
        : value <= 70
          ? 'ты легко не отвечаешь, если не в настроении или занята'
          : 'ты часто оставляешь сообщения без ответа и не считаешь это чем-то особенным';
  return `склонность к игнору: ${value}/100 — ${band}. Это не повод игнорировать всё подряд: решение всё равно зависит от ситуации.`;
}
