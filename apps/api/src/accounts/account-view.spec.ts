import { describe, expect, it } from 'vitest';
import type { TelegramAccountModel } from '@repo/database';
import { maskPhone, serializeAccount } from './account-view.js';

function accountRow(
  overrides: Partial<TelegramAccountModel> = {},
): TelegramAccountModel {
  return {
    id: 'acc-1',
    userId: 'user-1',
    tgUserId: 42n,
    firstName: 'Ann',
    lastName: null,
    username: 'ann',
    deviceProfile: '{}',
    isActive: true,
    activeSessionId: null,
    phoneEncrypted: null,
    phoneNonce: null,
    phoneTag: null,
    cloudPasswordEncrypted: null,
    lastUsedAt: null,
    createdAt: new Date('2026-11-20T10:00:00.000Z'),
    ...overrides,
  } as TelegramAccountModel;
}

describe('serializeAccount phone', () => {
  it('returns the decrypted phone in full and keeps the masked form', () => {
    const view = serializeAccount(accountRow(), [], '+15551234567');

    expect(view.phone).toBe('+15551234567');
    expect(view.phoneMasked).toBe('+*******4567');
  });

  it('returns null when the account has no stored phone', () => {
    const view = serializeAccount(accountRow());

    expect(view.phone).toBeNull();
    expect(view.phoneMasked).toBeNull();
  });

  it('keeps short numbers fully masked', () => {
    expect(maskPhone('+1234')).toBe('+****');
    expect(maskPhone('')).toBe('+*');
  });
});
