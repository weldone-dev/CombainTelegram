import { HttpException } from '@nestjs/common';
import {
  assertChatAdmin,
  assertGroupOrChannel,
  isChatAdmin,
  isGroupOrChannel,
  parseChatDescription,
  parseChatTitle,
  parseInviteName,
  parseInviteUsageLimit,
  parseMemberFilter,
  parseOptionalFlag,
  parseRank,
  parseSlowMode,
  SLOW_MODE_SECONDS,
  toAdminRights,
  toChatInviteView,
  toChatMemberView,
} from './chat-admin.service.js';

function errorCode(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { code?: string };
      return { code: body.code ?? '', status: error.getStatus() };
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('chat admin: member DTO mapping', () => {
  const base = {
    user: { id: 42, displayName: 'Роман', username: 'roman' },
    title: 'Модератор',
    joinedDate: new Date('2026-01-02T03:04:05.000Z'),
  };

  it('maps an admin with a custom rank', () => {
    expect(toChatMemberView({ ...base, status: 'admin' })).toEqual({
      id: 42,
      name: 'Роман',
      username: 'roman',
      status: 'admin',
      rank: 'Модератор',
      isAdmin: true,
      isCreator: false,
      joinedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('treats the creator as an admin and keeps missing fields null', () => {
    expect(
      toChatMemberView({
        user: { id: 7, displayName: 'Owner', username: null },
        status: 'creator',
      }),
    ).toEqual({
      id: 7,
      name: 'Owner',
      username: null,
      status: 'creator',
      rank: null,
      isAdmin: true,
      isCreator: true,
      joinedAt: null,
    });
  });

  it('maps banned and left members without admin flags', () => {
    expect(
      toChatMemberView({
        user: { id: 9, displayName: 'Spammer', username: 'spam' },
        status: 'banned',
        title: null,
        joinedDate: null,
      }),
    ).toMatchObject({
      status: 'banned',
      rank: null,
      isAdmin: false,
      isCreator: false,
      joinedAt: null,
    });
  });
});

describe('chat admin: admin gate decision', () => {
  it('allows admins and creators only', () => {
    expect(isChatAdmin({ isAdmin: true })).toBe(true);
    expect(isChatAdmin({ isCreator: true })).toBe(true);
    expect(isChatAdmin({ isAdmin: false, isCreator: false })).toBe(false);
    expect(isChatAdmin({})).toBe(false);
  });

  it('throws 403 CHAT_ADMIN_REQUIRED for regular members', () => {
    expect(errorCode(() => assertChatAdmin({ isAdmin: false }))).toEqual({
      code: 'CHAT_ADMIN_REQUIRED',
      status: 403,
    });
    expect(() => assertChatAdmin({ isCreator: true })).not.toThrow();
  });

  it('accepts groups and channels and rejects private peers', () => {
    expect(isGroupOrChannel('group')).toBe(true);
    expect(isGroupOrChannel('supergroup')).toBe(true);
    expect(isGroupOrChannel('channel')).toBe(true);
    expect(isGroupOrChannel('gigagroup')).toBe(true);
    expect(isGroupOrChannel('user')).toBe(false);
    expect(isGroupOrChannel(undefined)).toBe(false);
    expect(errorCode(() => assertGroupOrChannel('user'))).toEqual({
      code: 'NOT_A_GROUP',
      status: 400,
    });
  });
});

describe('chat admin: slow mode validation', () => {
  it('accepts every Telegram-allowed interval', () => {
    for (const seconds of SLOW_MODE_SECONDS) {
      expect(parseSlowMode(seconds)).toBe(seconds);
    }
  });

  it('rejects unsupported intervals with 400', () => {
    for (const value of [5, 120, 7200, 86401, -10, 1.5, '60', null, undefined]) {
      expect(errorCode(() => parseSlowMode(value))).toEqual({
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }
  });
});

describe('chat admin: title, description, rank validation', () => {
  it('trims the title and requires it to be non-empty', () => {
    expect(parseChatTitle('  Team  ')).toBe('Team');
    expect(errorCode(() => parseChatTitle('   '))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(errorCode(() => parseChatTitle('x'.repeat(256)))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('allows an empty description but caps it at 255', () => {
    expect(parseChatDescription('')).toBe('');
    expect(parseChatDescription('  hello  ')).toBe('hello');
    expect(errorCode(() => parseChatDescription('x'.repeat(256)))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('normalizes ranks', () => {
    expect(parseRank('  Модератор ')).toBe('Модератор');
    expect(parseRank('')).toBeNull();
    expect(parseRank(null)).toBeNull();
    expect(errorCode(() => parseRank('x'.repeat(17)))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });
});

describe('chat admin: admin rights mapping', () => {
  it('keeps only supported true flags', () => {
    expect(
      toAdminRights({
        changeInfo: true,
        deleteMessages: true,
        banUsers: false,
        inviteUsers: 'yes',
        unknownRight: true,
      }),
    ).toEqual({ changeInfo: true, deleteMessages: true });
  });

  it('maps every exposed right, including anonymous and manageTopics', () => {
    expect(
      toAdminRights({
        changeInfo: true,
        deleteMessages: true,
        banUsers: true,
        inviteUsers: true,
        pinMessages: true,
        manageCall: true,
        postMessages: true,
        editMessages: true,
        addAdmins: true,
        anonymous: true,
        manageTopics: true,
      }),
    ).toEqual({
      changeInfo: true,
      deleteMessages: true,
      banUsers: true,
      inviteUsers: true,
      pinMessages: true,
      manageCall: true,
      postMessages: true,
      editMessages: true,
      addAdmins: true,
      anonymous: true,
      manageTopics: true,
    });
  });

  it('keeps an empty selection as admin with no extra rights', () => {
    expect(toAdminRights({})).toEqual({ other: true });
    expect(toAdminRights(null)).toEqual({ other: true });
    expect(toAdminRights({ banUsers: false })).toEqual({ other: true });
  });
});

describe('chat admin: invite DTO mapping', () => {
  const base = {
    link: 'https://t.me/+abc',
    creator: { displayName: 'Роман' },
    isPrimary: false,
    isRevoked: false,
    usage: 3,
    usageLimit: 10,
    approvalNeeded: true,
    pendingApprovals: 2,
    endDate: new Date('2026-02-03T00:00:00.000Z'),
  };

  it('maps a limited link with approval and an expiry date', () => {
    expect(toChatInviteView(base)).toEqual({
      link: 'https://t.me/+abc',
      creatorName: 'Роман',
      isPrimary: false,
      isRevoked: false,
      usage: 3,
      usageLimit: 10,
      approvalNeeded: true,
      pendingJoinRequests: 2,
      expiresAt: '2026-02-03T00:00:00.000Z',
    });
  });

  it('renders unlimited/eternal links as null and missing creators honestly', () => {
    expect(
      toChatInviteView({
        ...base,
        creator: null,
        isPrimary: true,
        isRevoked: true,
        usageLimit: Number.POSITIVE_INFINITY,
        endDate: null,
      }),
    ).toMatchObject({
      creatorName: null,
      isPrimary: true,
      isRevoked: true,
      usageLimit: null,
      expiresAt: null,
    });
  });
});

describe('chat admin: query validation', () => {
  it('defaults the member filter to all and rejects unknown values', () => {
    expect(parseMemberFilter(undefined)).toBe('all');
    expect(parseMemberFilter('admins')).toBe('admins');
    expect(parseMemberFilter('banned')).toBe('banned');
    expect(errorCode(() => parseMemberFilter('restricted'))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('validates invite limits and names', () => {
    expect(parseInviteUsageLimit(undefined)).toBeUndefined();
    expect(parseInviteUsageLimit(10)).toBe(10);
    expect(errorCode(() => parseInviteUsageLimit(0))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(errorCode(() => parseInviteUsageLimit(100_000))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(parseInviteName('  promo  ')).toBe('promo');
    expect(parseInviteName('')).toBeUndefined();
    expect(errorCode(() => parseInviteName('x'.repeat(33)))).toEqual({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('validates boolean flags', () => {
    expect(parseOptionalFlag(undefined, 'withApproval')).toBeUndefined();
    expect(parseOptionalFlag(true, 'withApproval')).toBe(true);
    expect(errorCode(() => parseOptionalFlag('true', 'withApproval'))).toEqual(
      { code: 'VALIDATION_ERROR', status: 400 },
    );
  });
});
