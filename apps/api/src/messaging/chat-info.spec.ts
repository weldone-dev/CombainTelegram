import {
  toChatInfoFromFullChat,
  toChatInfoFromPeer,
  toChatInfoFromUser,
} from './chat-info.js';

describe('chat info DTO mapping', () => {
  it('maps a private user chat with the bio as about', () => {
    expect(
      toChatInfoFromUser({
        id: 1830539716,
        type: 'user',
        displayName: 'Роман',
        username: 'roman',
        bio: 'hello there',
      }),
    ).toEqual({
      id: 1830539716,
      type: 'user',
      title: 'Роман',
      username: 'roman',
      about: 'hello there',
      memberCount: null,
      onlineCount: null,
      isChannel: false,
      isGroup: false,
      isAdmin: false,
      isCreator: false,
      canSendMessages: true,
      inviteLink: null,
    });
  });

  it('maps service accounts (777000) and bots without a username', () => {
    expect(
      toChatInfoFromUser({
        id: 777000,
        type: 'user',
        displayName: 'Telegram',
        username: null,
        bio: null,
      }),
    ).toMatchObject({
      id: 777000,
      type: 'user',
      title: 'Telegram',
      username: null,
      about: null,
      memberCount: null,
      inviteLink: null,
      canSendMessages: true,
    });

    expect(
      toChatInfoFromUser({
        id: 12345,
        type: 'bot',
        displayName: 'Helper',
        username: 'helper_bot',
      }),
    ).toMatchObject({ type: 'bot', isChannel: false, isGroup: false });
  });

  it('maps a channel from the full-chat record', () => {
    expect(
      toChatInfoFromFullChat({
        id: -1002060803714,
        type: 'chat',
        chatType: 'channel',
        displayName: 'AID Notes',
        username: 'AIcode_AID',
        bio: 'Автоматизация',
        membersCount: 375,
        onlineCount: 12,
        isAdmin: false,
        isCreator: false,
        inviteLink: { link: 'https://t.me/AIcode_AID' },
      }),
    ).toEqual({
      id: -1002060803714,
      type: 'channel',
      title: 'AID Notes',
      username: 'AIcode_AID',
      about: 'Автоматизация',
      memberCount: 375,
      onlineCount: 12,
      isChannel: true,
      isGroup: false,
      isAdmin: false,
      isCreator: false,
      canSendMessages: false,
      inviteLink: 'https://t.me/AIcode_AID',
    });
  });

  it('maps a supergroup and treats zero counts as absent', () => {
    expect(
      toChatInfoFromFullChat({
        id: -1001234567890,
        type: 'chat',
        chatType: 'supergroup',
        displayName: 'Team',
        username: null,
        bio: '',
        membersCount: 0,
        onlineCount: 0,
        isAdmin: true,
        isCreator: false,
        permissions: { canSendMessages: true },
      }),
    ).toMatchObject({
      type: 'supergroup',
      about: null,
      memberCount: null,
      onlineCount: null,
      isGroup: true,
      isChannel: false,
      isAdmin: true,
      canSendMessages: true,
      inviteLink: null,
    });
  });

  it('builds a fallback view from getPeer fields', () => {
    expect(
      toChatInfoFromPeer({
        id: 1830539716,
        type: 'user',
        displayName: 'Роман',
        username: 'roman',
      }),
    ).toMatchObject({
      id: 1830539716,
      type: 'user',
      title: 'Роман',
      about: null,
      memberCount: null,
      onlineCount: null,
      isChannel: false,
      isGroup: false,
      canSendMessages: true,
      inviteLink: 'https://t.me/roman',
    });
  });
});
