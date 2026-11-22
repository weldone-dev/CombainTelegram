# Inspiration / reference projects

**Primary reference app: [64Gram](https://github.com/TDesktop-x64/tdesktop)** —
a fork of official Telegram Desktop with up to 100 account slots, per-account
session/storage, one active account and useful admin tools. It is the model for
our multi-account design and the source of official auth flows.
Secondary: **Nagram** (128 account slots, feature breadth, Android UX).
Telegram Web A/K are *not* multi-account references (one login per browser
profile).

Local, read-only clones of open-source Telegram clients (Android and desktop).
**Scope: functionality only.** Themes, icons, fonts, wallpapers and other
cosmetics are out of scope and not listed here.

> **License warning.** Almost all Android clients here are GPL-2.0/GPL-3.0.
> Copying their code into this repo would force this project to be GPL too.
> Use them to study behaviour, flows and edge cases — write our own code.

Local clones live in `inspiration/repos/` and are gitignored (several GB).
Everything below was verified via the GitHub API on 2026-11-16.

## Cloned locally — Android

| Local dir | Upstream | License | Functional value |
| --- | --- | --- | --- |
| `repos/Nagram` | [NextAlone/Nagram](https://github.com/NextAlone/Nagram) | GPL-3.0 | **Best functional reference.** Multi-account, proxies (MTProxy/SOCKS/vmess/ss/ssr/trojan + subscriptions), QR login, bulk message actions, quick reply, undo/redo, scrollable chat preview, translation, sticker pack backup, group management, stats. |
| `repos/Nekogram` | [Nekogram/Nekogram](https://github.com/Nekogram/Nekogram) | GPL-2.0 | Focused feature set: multi-engine translation (messages/chats/articles), free voice transcription, chat folder icons aside — the translator UX is the useful part. |
| `repos/TelegramAndroid` | [forkgram/TelegramAndroid](https://github.com/forkgram/TelegramAndroid) | GPL-2.0 | Small but concrete behaviour changes: delete-for-everyone default, forward without quoting sender, PiP for in-app YouTube, unread counts on bulk mark-read, archive pull-down, upload dates, privacy toggles. |
| `repos/Telegram-X` | [TGX-Android/Telegram-X](https://github.com/TGX-Android/Telegram-X) | GPL-3.0 | Official alternative client on **TDLib**: reference for update handling, message/media state machine, large-screen layout. |
| `repos/Cherrygram` | [arsLan4k1390/Cherrygram](https://github.com/arsLan4k1390/Cherrygram) | GPL-2.0 | Mostly customization — low priority for us. Keep only if we need a second opinion on settings UX; safe to delete. |

## Cloned locally — desktop

| Local dir | Upstream | License | Functional value |
| --- | --- | --- | --- |
| `repos/64Gram` | [TDesktop-x64/tdesktop](https://github.com/TDesktop-x64/tdesktop) | GPL-3.0 | Up to **10 accounts**, visible chat/message IDs, admin tools (ban in Recent Actions, join requests), option not to share phone when adding contacts. Best multi-account/admin reference. |
| `repos/Unigram` | [UnigramDev/Unigram](https://github.com/UnigramDev/Unigram) | GPL-3.0 | Native Windows client on **TDLib**: secret chats, calls, Windows integration. Reference for TDLib update flow and feature parity. |
| `repos/ForkgramDesktop` | [forkgram/tdesktop](https://github.com/forkgram/tdesktop) | GPL-3.0 | Quality-of-life: delete-for-everyone default, full online timestamps, custom URI scheme, always-on-top, media hotkeys. |
| `repos/AyuGramDesktop` | [AyuGram/AyuGramDesktop](https://github.com/AyuGram/AyuGramDesktop) | GPL-3.0 | Ghost mode and saved message history — **ToS-breaking**; read the mechanisms, don't ship them. |
| `repos/Yurigram` | [Revincx/Yurigram](https://github.com/Revincx/Yurigram) | GPL-3.0 | Per-chat enhanced settings, **BotUse** (login as a bot and send as it), multiple windows for one chat, local-only drafts, forwarding tweaks. |
| `repos/PaperPlane` | [paper-plane-developers/paper-plane](https://github.com/paper-plane-developers/paper-plane) | GPL-3.0 | Small **TDLib + GTK4/Rust** client — clean architecture reference. Last push 2025-01. |
| `repos/Yukigram` | [yukigram/yukigram](https://github.com/yukigram/yukigram) | no license file | Patch-based fork (patches on top of tdesktop), Linux/postmarketOS. Shows how to track upstream instead of maintaining a hard fork. |

Desktop clients not cloned:

| Project | License | Note |
| --- | --- | --- |
| [telegramdesktop/tdesktop](https://github.com/telegramdesktop/tdesktop) | GPL-3.0 | Official baseline (33.5k stars, active). Forks above are supersets; clone separately only if the base is needed. |
| [kotatogram/kotatogram-desktop](https://github.com/kotatogram/kotatogram-desktop) | GPL-3.0 | Experimental fork, but releases are stale (2022) — skip. |
| [kukuruzka165/materialgram](https://github.com/kukuruzka165/materialgram) | GPL-3.0 | Material Design restyle — cosmetic, no functional value for us. |

Update a clone:

```bash
cd inspiration/repos/Nagram && git pull --depth 1
```

## Functional extras these clients add over official Telegram

Only things that make sense for a web client:

- **Accounts:** unlimited logged-in accounts and fast switching (Nagram).
- **Proxy/network:** MTProxy, SOCKS5, IPv6 MTProxy, subscription import, proxy auto-switch, QR-shared proxies (Nagram).
- **Translation:** per-message, whole-chat and article translation; multiple engines; selected-text translation; voice transcription (Nekogram, Nagram).
- **Bulk actions:** mark multiple dialogs read, save multiple messages to Saved Messages, delete all messages in a group, bulk unpin, unblock all (Nagram).
- **Message tooling:** combine messages, quick reply, undo/redo, forced copy, inverted reply, scrollable chat preview (Nagram).
- **Group/channel administration:** upgrade to supergroup, create group without invites, member/permission tools, message stats (Nagram).
- **Data management:** keep original filenames on download, custom cache directory, sticker pack backup/restore/share, clear app data (Nagram).
- **Privacy controls:** default delete-for-everyone, hidden account names, hide chat avatar/title in chat list, secret-chat self-destruct timers, block secret chats from strangers (Forkgram, Nagram).
- **Sessions/login:** QR login, scan and confirm login QR, active session management (Nagram).
- **Media:** media grid, download manager, PiP playback, rear-camera video notes, upload dates on profile photos (Forkgram, Nagram).
- **Notifications:** UnifiedPush / push without Google services, per-chat behaviour (Forkgram, Telegram-FOSS).
- **Desktop-only, still relevant to us:** many accounts in one app (64Gram), chat/message IDs for support and moderation (64Gram), admin tools and join-request handling (64Gram), secret chats and calls on desktop (tdesktop, Unigram), export of chat history (tdesktop), per-chat settings and multiple windows (Yurigram), bot accounts (Yurigram BotUse).

**Not doing** (ToS-breaking or cosmetic): local "premium" unlocks, ghost mode, anti-delete/saved history, theme/icon engines.

## Functional backlog for the web app

Priority is for our product, not for the Android clients.

### Phase 1 — usable messenger
- Auth: phone + code + 2FA password (SRP), session persistence.
- Chat list: private chats, basic groups, channels, unread badges, pinned, archive, folders.
- Messages: text + entities (bold/italic/code/pre/link/mention), reply, edit, delete (me/all), forward, copy, multi-select.
- Media: photo/video/file/voice/video-note/sticker/GIF, captions, albums, upload/download progress.
- Realtime: new/edit/delete message, read receipts, typing, online status.
- Search: global, in-chat, by type (media/files/links).
- Profiles: name, bio, username, avatar; basic privacy settings.
- Notifications: in-app + web push.

### Phase 2 — power features
- Translation of message/chat/article + engine choice; voice transcription.
- Folders/filters management; drafts; scheduled and silent messages.
- Reactions, replies/threads, comments, polls.
- Stories.
- Multi-account switching; QR login; active sessions; logout by session.
- Bulk operations: mark read, save to Saved Messages, delete-all, bulk unpin.
- Group/channel admin: members, permissions, invite links, basic stats.
- Media grid + download manager + original filenames.
- Offline cache (IndexedDB) and reconnect/sync.

### Phase 3 — advanced
- Bots: commands, inline mode, keyboards.
- Calls (WebRTC) and screen sharing.
- Secret chats are **not supported by Telegram Web/MTProto web clients** — treat as out of scope unless we build a custom crypto layer.
- Data export/backup.
- Extensibility/plugins (design idea from exteraGram, but not its GPL code).

## Other candidates (not cloned)

| Project | License | Status | Functional note |
| --- | --- | --- | --- |
| [DrKLO/Telegram](https://github.com/DrKLO/Telegram) | GPL-2.0 | active | Official Android baseline; clones below are supersets. |
| [Telegram-FOSS-Team/Telegram-FOSS](https://github.com/Telegram-FOSS-Team/Telegram-FOSS) | GPL-2.0 | stale (2024) | Push without Google, FOSS codecs/maps. |
| [Mercurygram/Mercurygram](https://github.com/Mercurygram/Mercurygram) | GPL-2.0 | active | Telegram-FOSS fork with extra functional settings. |
| [risin42/NagramX](https://github.com/risin42/NagramX) | GPL-3.0 | **archived** | Nagram + AI translation, deleted-message handling (ideas only). |
| [HSSkyBoy/NiagramX](https://github.com/HSSkyBoy/NiagramX) | GPL-3.0 | new (2026-08) | Continuation of NagramX feature set; young project. |
| [AyuGram/AyuGram4A](https://github.com/AyuGram/AyuGram4A) | GPL-2.0 | stale (2023) | Ghost mode / saved history — concepts only, ToS-breaking. |
| [exteraSquad/exteraGram](https://github.com/exteraSquad/exteraGram) | GPL-2.0 | **archived** | Python plugin SDK + hooks — extensibility design reference. |
| [Ettacent/NimarkoGram](https://github.com/Ettacent/NimarkoGram) | GPL-2.0 | new | Python/DEX plugin platform, media workflows. |
| [NekoX-Dev/NekoX](https://github.com/NekoX-Dev/NekoX) | GPL-2.0 | low activity | Ancestor of Nagram's proxy/feature work. |
| [im030/Momogram](https://github.com/im030/Momogram) | GPL-3.0 | active | Small client, few functional extras. |

**Excluded:** Turrit — **closed source**, cannot be used as a reference.

## Web-specific references

| Project | License | Why |
| --- | --- | --- |
| [gram-js/gramjs](https://github.com/gram-js/gramjs) | MIT | MTProto client for Node/browser. Small (4 MB) and the most practical path for a NestJS backend. |
| [tdlib/td](https://github.com/tdlib/td) | BSL-1.0 | Official cross-platform Telegram library. **BSL is not OSI-open** — check terms before shipping. |
| [Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt) | GPL-3.0 | Telegram Web A. Best functional UX reference for a web messenger. |
| [morethanwords/tweb](https://github.com/morethanwords/tweb) | GPL-3.0 | Telegram Web K. Alternative architecture and feature set. |
| [telegramdesktop/tdesktop](https://github.com/telegramdesktop/tdesktop) | GPL-3.0 | Desktop client; large-screen layout, media and data export. |

## Protocol docs

- Telegram API: https://core.telegram.org/api
- MTProto: https://core.telegram.org/mtproto
- TDLib: https://core.telegram.org/tdlib
