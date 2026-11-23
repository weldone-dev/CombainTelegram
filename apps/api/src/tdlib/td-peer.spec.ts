import {
  chatIdFromPeer,
  guessedChatIdsFromPeer,
  peerIdFromTdChatId,
  peerIdFromTdChatType,
  peerTypeFromTdChatType,
  chatInfoKindFromTdChatType,
} from './td-peer.js';

const USER_ID = 1830539716;
const BASIC_GROUP_ID = 123456;
const SUPERGROUP_ID = 2060803714;
const CHANNEL_PEER = -(1_000_000_000_000 + SUPERGROUP_ID);

describe('td-peer', () => {
  it('maps a private chat to the user id', () => {
    const type = { _: 'chatTypePrivate', user_id: USER_ID } as const;
    expect(peerIdFromTdChatType(type)).toBe(USER_ID);
    expect(chatIdFromPeer(type, USER_ID)).toBe(USER_ID);
    expect(peerTypeFromTdChatType(type)).toBe('user');
    expect(chatInfoKindFromTdChatType(type)).toBe('user');
  });

  it('maps a basic group to its positive id and back to a negative chat id', () => {
    const type = { _: 'chatTypeBasicGroup', basic_group_id: BASIC_GROUP_ID };
    expect(peerIdFromTdChatType(type)).toBe(BASIC_GROUP_ID);
    expect(chatIdFromPeer(type, BASIC_GROUP_ID)).toBe(-BASIC_GROUP_ID);
    expect(peerTypeFromTdChatType(type)).toBe('chat');
    expect(chatInfoKindFromTdChatType(type)).toBe('group');
  });

  it('maps a supergroup to a marked channel id', () => {
    const type = {
      _: 'chatTypeSupergroup',
      supergroup_id: SUPERGROUP_ID,
      is_channel: false,
    };
    expect(peerIdFromTdChatType(type)).toBe(CHANNEL_PEER);
    expect(chatIdFromPeer(type, CHANNEL_PEER)).toBe(CHANNEL_PEER);
    expect(peerTypeFromTdChatType(type)).toBe('chat');
    expect(chatInfoKindFromTdChatType(type)).toBe('supergroup');
  });

  it('distinguishes channels from supergroups', () => {
    const type = {
      _: 'chatTypeSupergroup',
      supergroup_id: SUPERGROUP_ID,
      is_channel: true,
    };
    expect(chatInfoKindFromTdChatType(type)).toBe('channel');
  });

  it('round-trips every supported chat type', () => {
    const cases = [
      { _: 'chatTypePrivate', user_id: USER_ID },
      { _: 'chatTypeBasicGroup', basic_group_id: BASIC_GROUP_ID },
      {
        _: 'chatTypeSupergroup',
        supergroup_id: SUPERGROUP_ID,
        is_channel: true,
      },
    ] as const;
    for (const type of cases) {
      const peerId = peerIdFromTdChatType(type);
      expect(peerId).not.toBeNull();
      expect(chatIdFromPeer(type, peerId as number)).not.toBeNull();
    }
  });

  it('rejects mismatched peer ids instead of guessing', () => {
    expect(
      chatIdFromPeer(
        { _: 'chatTypeSupergroup', supergroup_id: SUPERGROUP_ID },
        123,
      ),
    ).toBeNull();
    expect(
      chatIdFromPeer({ _: 'chatTypePrivate', user_id: USER_ID }, -USER_ID),
    ).toBeNull();
    expect(chatIdFromPeer({ _: 'chatTypeUnknown' }, 1)).toBeNull();
  });

  it('derives a marked peer id from a raw TDLib chat id', () => {
    expect(peerIdFromTdChatId(USER_ID)).toBe(USER_ID);
    expect(peerIdFromTdChatId(-BASIC_GROUP_ID)).toBe(BASIC_GROUP_ID);
    expect(peerIdFromTdChatId(CHANNEL_PEER)).toBe(CHANNEL_PEER);
    expect(peerIdFromTdChatId(0)).toBeNull();
  });

  it('offers candidate chat ids for a typed lookup', () => {
    expect(guessedChatIdsFromPeer(USER_ID)).toEqual([USER_ID, -USER_ID]);
    expect(guessedChatIdsFromPeer(CHANNEL_PEER)).toEqual([CHANNEL_PEER]);
    expect(guessedChatIdsFromPeer(0)).toEqual([]);
  });
});
