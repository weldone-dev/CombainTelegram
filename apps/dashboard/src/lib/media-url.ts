import { API_URL } from "./api";
import type { MessageMediaKind, MessageMediaView } from "./types";

/** Local-only debugging switch for the AI frame collage row. */
export const AI_FRAMES_STORAGE_KEY = "tg-show-ai-frames";

/**
 * `GET .../messages/:messageId/frames` — a 3x3 JPEG collage of a video-ish
 * message, produced by the API for the AI vision pipeline. Dashboard-only.
 */
export function framesUrl(
  accountId: string,
  chatId: number,
  messageId: number,
): string {
  return `${API_URL}/accounts/${encodeURIComponent(accountId)}/chats/${chatId}/messages/${messageId}/frames`;
}

/** Frames are a debugging aid, so the default is on. */
export function readAiFramesPreference(): boolean {
  try {
    return window.localStorage.getItem(AI_FRAMES_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeAiFramesPreference(next: boolean): void {
  try {
    window.localStorage.setItem(AI_FRAMES_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the in-memory choice still applies.
  }
}

/** Playback container of a sticker: `.tgs`, WebM or (animated) WebP. */
export type StickerFormat = "tgs" | "webm" | "webp" | "unknown";

function lower(value: string | null | undefined): string {
  return value ? value.toLowerCase() : "";
}

/** Mime/file-name sniffing for stickers, independent of the server kind. */
export function stickerFormat(media: MessageMediaView): StickerFormat {
  const mime = lower(media.mimeType);
  const name = lower(media.fileName);
  if (mime.includes("x-tgsticker") || name.endsWith(".tgs")) return "tgs";
  if (mime === "video/webm" || name.endsWith(".webm")) return "webm";
  if (mime === "image/webp" || name.endsWith(".webp")) return "webp";
  return "unknown";
}

/** Whether the media is a video container the browser can play as a GIF. */
export function isGifLike(media: MessageMediaView): boolean {
  const mime = lower(media.mimeType);
  const name = lower(media.fileName);
  return (
    mime === "video/mp4" ||
    mime === "image/gif" ||
    mime === "video/webm" ||
    name.endsWith(".gif") ||
    name.endsWith(".mp4")
  );
}

/**
 * Resolve the renderable kind. Newer APIs send `sticker`/`animation` directly;
 * older payloads still say `other`, so mime and the legacy `mediaType` string
 * are used as a fallback instead of showing a bare `[sticker]` label.
 */
export function resolveMediaKind(
  media: MessageMediaView,
  mediaType?: string | null,
): MessageMediaKind {
  if (media.kind !== "other") return media.kind;
  const type = lower(mediaType);
  const mime = lower(media.mimeType);
  if (type === "sticker" || mime.includes("x-tgsticker")) return "sticker";
  // Check the explicit legacy types before the mime: an MP4 document is a
  // document/video, while a GIF animation arrives as `animation`/`GIF`.
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (type === "animation" || type === "gif" || isGifLike(media)) {
    return "animation";
  }
  return "other";
}

/** Kinds that paint their own body, so the `[mediaType]` fallback stays hidden. */
const MEDIA_BODY_KINDS: ReadonlySet<MessageMediaKind> = new Set([
  "photo",
  "document",
  "voice",
  "audio",
  "video",
  "video_note",
  "sticker",
  "animation",
]);

export function hasMediaBody(
  media: MessageMediaView | null | undefined,
  mediaType?: string | null,
): boolean {
  if (!media) return false;
  return MEDIA_BODY_KINDS.has(resolveMediaKind(media, mediaType));
}
