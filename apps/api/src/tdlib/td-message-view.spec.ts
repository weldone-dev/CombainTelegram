import type { chat, message } from 'tdlib-native/types';
import {
  canSendInTdChat,
  mediaFileInfo,
  peerOfTdChat,
  peerOfTdUser,
  tdUsername,
  toChatViewFromTd,
  toMessageViewFromTd,
} from './td-message-view.js';
import type { PeerLike } from '../messaging/message-view.js';

const USER_ID = 1830539716;
const SUPERGROUP_ID = 2060803714;
const CHANNEL_ID = -(1_000_000_000_000 + SUPERGROUP_ID);

const text = (value: string) => ({
  _: 'formattedText',
  text: value,
  entities: [],
});

function message(
  content: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): message {
  const normalized =
    content._ === 'formattedText'
      ? {
          _: 'messageText',
          text: content,
          link_preview: null,
          link_preview_options: null,
        }
      : content;
  return {
    _: 'message',
    id: 42,
    sender_id: { _: 'messageSenderUser', user_id: USER_ID },
    receiver_id: null,
    chat_id: USER_ID,
    sending_state: null,
    scheduling_state: null,
    is_outgoing: false,
    is_pinned: false,
    is_from_offline: false,
    can_be_saved: true,
    has_timestamped_media: false,
    is_channel_post: false,
    is_paid_star_suggested_post: false,
    is_paid_gram_suggested_post: false,
    contains_unread_mention: false,
    contains_unread_poll_votes: false,
    date: 1_700_000_000,
    edit_date: 0,
    forward_info: null,
    import_info: null,
    interaction_info: null,
    unread_reactions: [],
    fact_check: null,
    suggested_post_info: null,
    reply_to: null,
    topic_id: null,
    self_destruct_type: null,
    self_destruct_in: 0,
    auto_delete_in: 0,
    via_bot_user_id: 0,
    guest_bot_caller_id: null,
    sender_business_bot_user_id: 0,
    sender_boost_count: 0,
    sender_tag: '',
    paid_message_star_count: 0,
    author_signature: '',
    media_album_id: '0',
    effect_id: '0',
    restriction_info: null,
    summary_language_code: '',
    content: normalized,
    ephemeral_content: null,
    reply_markup: null,
    ephemeral_message_id: 0,
    chat_instance: '0',
    ...overrides,
  } as unknown as message;
}

const file = (id: number, size: number) => ({
  _: 'file',
  id,
  size,
  expected_size: size,
  local: {
    _: 'localFile',
    path: '',
    can_be_downloaded: true,
    can_be_deleted: false,
    is_downloading_active: false,
    is_downloading_completed: false,
    download_offset: 0,
    downloaded_prefix_size: 0,
    downloaded_size: 0,
  },
  remote: {
    _: 'remoteFile',
    id: String(id),
    unique_id: `unique-${id}`,
    is_uploading_active: false,
    is_uploading_completed: true,
    uploaded_size: size,
  },
});

const peer = (name: string): PeerLike => ({
  id: USER_ID,
  type: 'user',
  displayName: name,
  username: 'alice',
});

function privateChat(): chat {
  return {
    _: 'chat',
    id: USER_ID,
    type: { _: 'chatTypePrivate', user_id: USER_ID },
    title: 'Alice',
    photo: null,
    permissions: {
      _: 'chatPermissions',
      can_send_basic_messages: true,
    },
    last_message: null,
    positions: [],
    chat_lists: [{ _: 'chatListMain' }],
    unread_count: 0,
    last_read_inbox_message_id: 0,
    notification_settings: {
      _: 'chatNotificationSettings',
      use_default_mute_for: true,
      mute_for: 0,
    },
  } as unknown as chat;
}

function channelChat(overrides: Record<string, unknown> = {}): chat {
  return {
    ...privateChat(),
    id: CHANNEL_ID,
    type: {
      _: 'chatTypeSupergroup',
      supergroup_id: SUPERGROUP_ID,
      is_channel: true,
    },
    title: 'AID Notes',
    permissions: {
      _: 'chatPermissions',
      can_send_basic_messages: true,
    },
    ...overrides,
  } as unknown as chat;
}

describe('td-message-view', () => {
  const ctx = {
    chat: privateChat(),
    resolveSender: () => peer('Alice'),
  };

  it('maps a plain text message with reply and edited state', () => {
    const view = toMessageViewFromTd(
      message(text('hello'), {
        is_outgoing: true,
        edit_date: 1_700_000_100,
        reply_to: {
          _: 'messageReplyToMessage',
          chat_id: USER_ID,
          message_id: 7,
          quote: null,
          checklist_task_id: 0,
          poll_option_id: '',
          origin: null,
          origin_send_date: 0,
          content: null,
        },
      }),
      ctx,
    );

    expect(view).toMatchObject({
      id: 42,
      chatId: USER_ID,
      text: 'hello',
      outgoing: true,
      edited: true,
      senderId: USER_ID,
      senderName: 'Alice',
      replyToId: 7,
      mediaType: null,
      media: null,
      isVoice: false,
      service: false,
    });
    expect(view.date).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('maps the quote text of a replied message', () => {
    const view = toMessageViewFromTd(
      message(text('hello'), {
        reply_to: {
          _: 'messageReplyToMessage',
          chat_id: USER_ID,
          message_id: 7,
          quote: { _: 'textQuote', text: text('ты где был'), position: 0, is_manual: true },
          checklist_task_id: 0,
          poll_option_id: '',
          origin: null,
          origin_send_date: 0,
          content: null,
        },
      }),
      ctx,
    );
    expect(view.replyToId).toBe(7);
    expect(view.replyToText).toBe('ты где был');
  });

  it('maps a TDLib forward origin to forwardedFrom', () => {
    const fromChannel = toMessageViewFromTd(
      message(text('мем'), {
        forward_info: {
          _: 'messageForwardInfo',
          origin: {
            _: 'messageOriginChannel',
            chat_id: -1_000_000_000_777,
            message_id: 5,
            author_signature: 'редакция',
          },
          date: 1_700_000_000,
          source: null,
          public_service_announcement_type: '',
        },
      }),
      {
        ...ctx,
        chatName: (id: number) =>
          id === -1_000_000_000_777 ? 'Мемный канал' : undefined,
      },
    );
    expect(fromChannel.forwardedFrom).toBe('Мемный канал (редакция)');

    const fromHiddenUser = toMessageViewFromTd(
      message(text('привет'), {
        forward_info: {
          _: 'messageForwardInfo',
          origin: { _: 'messageOriginHiddenUser', sender_name: 'Аноним' },
          date: 1_700_000_000,
          source: null,
          public_service_announcement_type: '',
        },
      }),
      ctx,
    );
    expect(fromHiddenUser.forwardedFrom).toBe('Аноним');
  });

  it('maps a photo with caption and a downloadable descriptor', () => {
    const view = toMessageViewFromTd(
      message({
        _: 'messagePhoto',
        photo: {
          _: 'photo',
          has_stickers: false,
          minithumbnail: null,
          sizes: [
            {
              _: 'photoSize',
              type: 's',
              width: 90,
              height: 90,
              photo: file(1, 900),
              progressive_sizes: [],
            },
            {
              _: 'photoSize',
              type: 'x',
              width: 1280,
              height: 1280,
              photo: file(2, 240_000),
              progressive_sizes: [],
            },
          ],
        },
        video: null,
        caption: text('look'),
        show_caption_above_media: false,
        has_spoiler: false,
        is_secret: false,
      }),
      ctx,
    );

    expect(view.text).toBe('look');
    expect(view.mediaType).toBe('photo');
    expect(view.media).toEqual({
      kind: 'photo',
      mimeType: 'image/jpeg',
      fileName: null,
      size: 240_000,
      downloadable: true,
    });
  });

  it('maps video, video note, voice, audio, document and animation', () => {
    const video = toMessageViewFromTd(
      message({
        _: 'messageVideo',
        video: {
          _: 'video',
          duration: 12,
          width: 1280,
          height: 720,
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          has_stickers: false,
          supports_streaming: true,
          minithumbnail: null,
          thumbnail: null,
          video: file(10, 5_000_000),
        },
        alternative_videos: [],
        storyboards: [],
        cover: null,
        start_timestamp: 0,
        caption: text(''),
        show_caption_above_media: false,
        has_spoiler: false,
        is_secret: false,
      }),
      ctx,
    );
    expect(video.mediaType).toBe('video');
    expect(video.media?.fileName).toBe('clip.mp4');
    expect(video.media?.downloadable).toBe(false);

    const note = toMessageViewFromTd(
      message({
        _: 'messageVideoNote',
        video_note: {
          _: 'videoNote',
          duration: 5,
          waveform: '',
          length: 240,
          minithumbnail: null,
          thumbnail: null,
          speech_recognition_result: null,
          video: file(11, 1_000_000),
        },
        is_viewed: false,
        is_secret: false,
      }),
      ctx,
    );
    expect(note.mediaType).toBe('video');
    expect(note.media?.size).toBe(1_000_000);

    const voice = toMessageViewFromTd(
      message({
        _: 'messageVoiceNote',
        voice_note: {
          _: 'voiceNote',
          duration: 3,
          waveform: '',
          mime_type: 'audio/ogg',
          speech_recognition_result: null,
          voice: file(12, 20_000),
        },
        caption: text(''),
        is_listened: false,
      }),
      ctx,
    );
    expect(voice.mediaType).toBe('voice');
    expect(voice.isVoice).toBe(true);
    expect(voice.media).toMatchObject({ kind: 'voice', mimeType: 'audio/ogg' });

    const audio = toMessageViewFromTd(
      message({
        _: 'messageAudio',
        audio: {
          _: 'audio',
          duration: 200,
          title: 'Song',
          performer: 'Band',
          file_name: 'song.mp3',
          mime_type: 'audio/mpeg',
          album_cover_minithumbnail: null,
          album_cover_thumbnail: null,
          external_album_covers: [],
          audio: file(13, 3_000_000),
        },
        caption: text(''),
      }),
      ctx,
    );
    expect(audio.mediaType).toBe('audio');
    expect(audio.media).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/mpeg',
    });

    const doc = toMessageViewFromTd(
      message({
        _: 'messageDocument',
        document: {
          _: 'document',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          minithumbnail: null,
          thumbnail: null,
          document: file(14, 400_000),
        },
        caption: text(''),
      }),
      ctx,
    );
    expect(doc.media).toEqual({
      kind: 'document',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      size: 400_000,
      downloadable: true,
    });

    const animation = toMessageViewFromTd(
      message({
        _: 'messageAnimation',
        animation: {
          _: 'animation',
          duration: 2,
          width: 320,
          height: 240,
          file_name: 'loop.mp4',
          mime_type: 'video/mp4',
          has_stickers: false,
          minithumbnail: null,
          thumbnail: null,
          animation: file(15, 800_000),
        },
        caption: text(''),
        show_caption_above_media: false,
        has_spoiler: false,
        is_secret: false,
      }),
      ctx,
    );
    expect(animation.mediaType).toBe('video');
    expect(animation.media?.size).toBe(800_000);
  });

  it('maps sticker, animated emoji, GIF and video note without placeholders', () => {
    const baseSticker = {
      _: 'sticker',
      id: '1',
      set_id: '2',
      width: 512,
      height: 512,
      emoji: '🐷',
      full_type: { _: 'stickerFullTypeRegular', premium_animation: null },
      thumbnail: null,
      sticker: file(16, 30_000),
    };

    const staticSticker = toMessageViewFromTd(
      message({
        _: 'messageSticker',
        sticker: { ...baseSticker, format: { _: 'stickerFormatWebp' } },
        is_premium: false,
      }),
      ctx,
    );
    expect(staticSticker.text).toBe('🐷');
    expect(staticSticker.mediaType).toBe('sticker');
    expect(staticSticker.media).toEqual({
      kind: 'sticker',
      mimeType: 'image/webp',
      fileName: 'sticker.webp',
      size: 30_000,
      downloadable: true,
      // TDLib remote id: the sticker library can re-send it via getRemoteFile.
      fileId: 'unique-16',
      emoji: '🐷',
      width: 512,
      height: 512,
    });

    const tgsSticker = toMessageViewFromTd(
      message({
        _: 'messageSticker',
        sticker: { ...baseSticker, format: { _: 'stickerFormatTgs' } },
        is_premium: false,
      }),
      ctx,
    );
    expect(tgsSticker.media).toMatchObject({
      kind: 'sticker',
      mimeType: 'application/x-tgsticker',
      fileName: 'sticker.tgs',
      emoji: '🐷',
      isAnimated: true,
      width: 512,
      height: 512,
    });

    const webmSticker = toMessageViewFromTd(
      message({
        _: 'messageSticker',
        sticker: { ...baseSticker, format: { _: 'stickerFormatWebm' } },
        is_premium: false,
      }),
      ctx,
    );
    expect(webmSticker.media).toMatchObject({
      mimeType: 'video/webm',
      fileName: 'sticker.webm',
      isAnimated: true,
    });

    const animatedEmoji = toMessageViewFromTd(
      message({
        _: 'messageAnimatedEmoji',
        animated_emoji: {
          _: 'animatedEmoji',
          sticker: { ...baseSticker, format: { _: 'stickerFormatTgs' } },
          sticker_width: 512,
          sticker_height: 512,
          fitzpatrick_type: 0,
          sound: null,
          is_regular_emoji: true,
        },
        emoji: '🐷',
      }),
      ctx,
    );
    expect(animatedEmoji.text).toBe('🐷');
    expect(animatedEmoji.text).not.toBe('[Unsupported message]');
    expect(animatedEmoji.media).toMatchObject({
      kind: 'sticker',
      mimeType: 'application/x-tgsticker',
      emoji: '🐷',
      isAnimated: true,
    });

    const gif = toMessageViewFromTd(
      message({
        _: 'messageAnimation',
        animation: {
          _: 'animation',
          duration: 3,
          width: 480,
          height: 270,
          file_name: 'cat.gif',
          mime_type: 'image/gif',
          has_stickers: false,
          minithumbnail: null,
          thumbnail: null,
          animation: file(17, 900_000),
        },
        caption: text('смотри'),
        show_caption_above_media: false,
        has_spoiler: false,
        is_secret: false,
      }),
      ctx,
    );
    expect(gif.text).toBe('смотри');
    expect(gif.mediaType).toBe('video');
    expect(gif.media).toMatchObject({
      kind: 'animation',
      mimeType: 'image/gif',
      fileName: 'cat.gif',
      size: 900_000,
      downloadable: true,
      isAnimated: true,
      width: 480,
      height: 270,
      durationSec: 3,
    });

    const note = toMessageViewFromTd(
      message({
        _: 'messageVideoNote',
        video_note: {
          _: 'videoNote',
          duration: 7,
          waveform: '',
          length: 240,
          minithumbnail: null,
          thumbnail: null,
          speech_recognition_result: null,
          video: file(18, 700_000),
        },
        is_viewed: false,
        is_secret: false,
      }),
      ctx,
    );
    expect(note.mediaType).toBe('video');
    expect(note.media).toMatchObject({
      kind: 'video_note',
      mimeType: 'video/mp4',
      downloadable: true,
      width: 240,
      height: 240,
      durationSec: 7,
    });
  });

  it('keeps a sticker emoji in text even when Telegram omits it', () => {
    const view = toMessageViewFromTd(
      message({
        _: 'messageSticker',
        sticker: {
          _: 'sticker',
          id: '1',
          set_id: '2',
          width: 512,
          height: 512,
          emoji: '',
          format: { _: 'stickerFormatWebp' },
          full_type: { _: 'stickerFullTypeRegular', premium_animation: null },
          thumbnail: null,
          sticker: file(19, 1000),
        },
        is_premium: false,
      }),
      ctx,
    );
    expect(view.text).toBe('');
    expect(view.text).not.toBe('[Unsupported message]');
    expect(view.media?.emoji).toBeUndefined();
  });

  it('maps a dice', () => {
    const dice = toMessageViewFromTd(
      message({
        _: 'messageDice',
        initial_state: null,
        final_state: null,
        emoji: '🎲',
        value: 6,
        success_animation_frame_number: 0,
      }),
      ctx,
    );
    expect(dice.mediaType).toBe('dice');
    expect(dice.text).toBe('🎲 6');
  });

  it('maps location, venue and contact to readable text', () => {
    const location = toMessageViewFromTd(
      message({
        _: 'messageLocation',
        location: {
          _: 'location',
          latitude: 55.75,
          longitude: 37.61,
          horizontal_accuracy: 0,
        },
      }),
      ctx,
    );
    expect(location.text).toContain('55.75');

    const venue = toMessageViewFromTd(
      message({
        _: 'messageVenue',
        venue: {
          _: 'venue',
          location: {
            _: 'location',
            latitude: 1,
            longitude: 2,
            horizontal_accuracy: 0,
          },
          title: 'Cafe',
          address: 'Main st 1',
          provider: 'foursquare',
          id: 'v1',
          type: 'cafe',
        },
      }),
      ctx,
    );
    expect(venue.mediaType).toBe('venue');
    expect(venue.text).toContain('Cafe');

    const contact = toMessageViewFromTd(
      message({
        _: 'messageContact',
        contact: {
          _: 'contact',
          phone_number: '+10000000000',
          first_name: 'Bob',
          last_name: 'Smith',
          vcard: '',
          user_id: 0,
        },
      }),
      ctx,
    );
    expect(contact.mediaType).toBe('contact');
    expect(contact.text).toContain('Bob Smith');
  });

  it('maps a poll with answers, vote state and quiz solution', () => {
    const view = toMessageViewFromTd(
      message({
        _: 'messagePoll',
        description: text(''),
        media: null,
        can_add_option: false,
        poll: {
          _: 'poll',
          id: '99',
          question: text('Best?'),
          options: [
            {
              _: 'pollOption',
              id: 'a',
              text: text('One'),
              media: null,
              voter_count: 3,
              vote_percentage: 60,
              recent_voter_ids: [],
              is_chosen: true,
              is_being_chosen: false,
              author: null,
              addition_date: 0,
            },
            {
              _: 'pollOption',
              id: 'b',
              text: text('Two'),
              media: null,
              voter_count: 2,
              vote_percentage: 40,
              recent_voter_ids: [],
              is_chosen: false,
              is_being_chosen: false,
              author: null,
              addition_date: 0,
            },
          ],
          total_voter_count: 5,
          recent_voter_ids: [],
          can_get_voters: false,
          can_see_results: true,
          is_anonymous: true,
          allows_multiple_answers: false,
          allows_revoting: false,
          members_only: false,
          country_codes: [],
          option_order: [],
          type: {
            _: 'pollTypeQuiz',
            correct_option_ids: [0],
            explanation: text('Because'),
            explanation_media: null,
          },
          open_period: 0,
          close_date: 0,
          is_closed: false,
          vote_restriction_reason: null,
        },
      }),
      ctx,
    );

    expect(view.mediaType).toBe('poll');
    expect(view.poll).toEqual({
      id: '99',
      question: 'Best?',
      closed: false,
      quiz: true,
      multiple: false,
      voters: 5,
      hideResultsUntilClose: false,
      answers: [
        { index: 0, text: 'One', voters: 3, chosen: true, correct: true },
        { index: 1, text: 'Two', voters: 2, chosen: false, correct: false },
      ],
      solution: 'Because',
    });
  });

  it('maps reactions summary', () => {
    const view = toMessageViewFromTd(
      message(text('nice'), {
        interaction_info: {
          _: 'messageInteractionInfo',
          view_count: 0,
          forward_count: 0,
          reply_info: null,
          reactions: {
            _: 'messageReactions',
            reactions: [
              {
                _: 'messageReaction',
                type: { _: 'reactionTypeEmoji', emoji: '👍' },
                total_count: 4,
                is_chosen: true,
                used_sender_id: null,
                recent_sender_ids: [],
              },
              {
                _: 'messageReaction',
                type: {
                  _: 'reactionTypeCustomEmoji',
                  custom_emoji_id: '12345',
                },
                total_count: 1,
                is_chosen: false,
                used_sender_id: null,
                recent_sender_ids: [],
              },
            ],
            are_tags: false,
            paid_reactors: [],
            can_get_added_reactions: false,
          },
        },
      }),
      ctx,
    );

    expect(view.reactions).toEqual([
      { emoji: '👍', count: 4, chosen: true },
      { emoji: 'custom:12345', count: 1, chosen: false },
    ]);
  });

  it('maps service messages and unknown content without throwing', () => {
    const service = toMessageViewFromTd(
      message({
        _: 'messageChatAddMembers',
        member_user_ids: [1, 2],
      }),
      ctx,
    );
    expect(service.service).toBe(true);
    expect(service.text).toBe('');

    const unsupported = toMessageViewFromTd(
      message({ _: 'messageUnsupported' }),
      ctx,
    );
    expect(unsupported.media).toBeNull();
    expect(unsupported.text).toBe('[Unsupported message]');
  });

  it('handles inline keyboards, albums and forwards without a parallel shape', () => {
    const view = toMessageViewFromTd(
      message(text('buttons'), {
        media_album_id: '777',
        reply_markup: {
          _: 'replyMarkupInlineKeyboard',
          rows: [
            [
              {
                _: 'inlineKeyboardButton',
                text: 'Open',
                icon_custom_emoji_id: '0',
                style: { _: 'buttonStyleDefault' },
                type: {
                  _: 'inlineKeyboardButtonTypeUrl',
                  url: 'https://t.me/example',
                },
              },
            ],
          ],
          force_reply: false,
        },
        forward_info: {
          _: 'messageForwardInfo',
          origin: { _: 'messageOriginUser', sender_user_id: 5 },
          date: 1_600_000_000,
          source: null,
          public_service_announcement_type: '',
        },
      }),
      ctx,
    );

    expect(view.text).toBe('buttons');
    expect(view.mediaType).toBeNull();
    // The public DTO has no fields for keyboards/albums/forwards.
    expect(Object.keys(view)).not.toContain('keyboard');
  });

  it('maps a chat view with pinned, muted and archived state', () => {
    const entry = privateChat();
    entry.last_message = message(text('last'));
    entry.positions = [
      {
        _: 'chatPosition',
        list: { _: 'chatListMain' },
        order: '1',
        is_pinned: true,
        source: null,
      },
    ];
    entry.chat_lists = [{ _: 'chatListArchive' }];
    entry.unread_count = 3;
    entry.last_read_inbox_message_id = 41;
    entry.notification_settings = {
      _: 'chatNotificationSettings',
      use_default_mute_for: false,
      mute_for: 3600,
    } as chat['notification_settings'];

    const view = toChatViewFromTd(entry, {
      username: 'alice',
      resolveSender: () => peer('Alice'),
    });

    expect(view).toMatchObject({
      id: USER_ID,
      type: 'user',
      title: 'Alice',
      username: 'alice',
      unreadCount: 3,
      pinned: true,
      muted: true,
      archived: true,
      readInboxMaxId: 41,
      canSendMessages: true,
    });
    // The dialog's lastMessage is produced by the same mapper as the transcript.
    expect(view.lastMessage?.text).toBe('last');
  });

  it('refuses to let non-admin channel followers post', () => {
    const entry = channelChat();
    expect(canSendInTdChat(entry)).toBe(false);
    expect(canSendInTdChat(entry, { isAdmin: true })).toBe(true);
  });

  it('maps helpers for users and chat peers', () => {
    const user = {
      _: 'user',
      id: USER_ID,
      first_name: 'Alice',
      last_name: 'Cooper',
      usernames: {
        _: 'usernames',
        active_usernames: ['alice'],
        disabled_usernames: [],
        editable_username: 'alice',
        collectible_usernames: [],
        secondary_username: '',
      },
    } as unknown as Parameters<typeof peerOfTdUser>[0];
    expect(peerOfTdUser(user, 0)).toMatchObject({
      id: USER_ID,
      displayName: 'Alice Cooper',
      username: 'alice',
    });
    expect(tdUsername(user?.usernames ?? null)).toBe('alice');
    expect(peerOfTdChat(channelChat())).toMatchObject({
      id: CHANNEL_ID,
      type: 'chat',
      chatType: 'channel',
    });
  });

  it('exposes the same file pointers used by downloads', () => {
    const info = mediaFileInfo(
      message({
        _: 'messageDocument',
        document: {
          _: 'document',
          file_name: 'a.bin',
          mime_type: 'application/octet-stream',
          minithumbnail: null,
          thumbnail: null,
          document: file(20, 10),
        },
        caption: text(''),
      }),
    );
    expect(info).toMatchObject({
      type: 'document',
      fileName: 'a.bin',
      mimeType: 'application/octet-stream',
      size: 10,
    });
    expect(info?.file?.id).toBe(20);
    expect(info?.thumb).toBeNull();
    expect(mediaFileInfo(message(text('no media')))).toBeNull();
  });
});
