"use client";

import type { AnimationItem } from "lottie-web";
import type { SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mediaUrl } from "../../lib/api";
import { framesUrl, stickerFormat } from "../../lib/media-url";
import type { MessageView } from "../../lib/types";

/** Props shared by the media bubbles rendered inside a chat message. */
export interface MediaBubbleProps {
  message: MessageView;
  accountId: string;
  selecting: boolean;
  /** Dashboard-only debugging switch for the AI frame collage row. */
  showAiFrames: boolean;
}

function playGlyph(className: string) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white/80"
    />
  );
}

/**
 * A looping, muted, chromeless video used for WebM stickers, MP4 GIFs and
 * animated emoji. Clicking the surrounding link opens the original file.
 */
function LoopingVideo({
  src,
  poster,
  className,
  label,
  onError,
}: {
  src: string;
  poster?: string;
  className: string;
  label: string;
  onError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Autoplaying loops are cheap to pause while the tab is in the background.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const resume = () => {
      if (document.hidden) return;
      void video.play().catch(() => {
        // Automatic playback refused; the poster stays visible.
      });
    };
    const onVisibility = () => {
      if (document.hidden) video.pause();
      else resume();
    };
    // Some browsers suppress autoplay while the tab or element is still
    // initialising, so retry when the media can play and when the tab returns.
    resume();
    video.addEventListener("canplay", resume);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      video.removeEventListener("canplay", resume);
      document.removeEventListener("visibilitychange", onVisibility);
      video.pause();
    };
  }, []);

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      aria-label={label}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      disablePictureInPicture
      onError={onError}
      className={className}
    />
  );
}

/**
 * `.tgs` is gzipped Lottie JSON. Telegram stickers are standard vector Lottie
 * animations, so `lottie-web`'s light (SVG-only) build plays them directly.
 */
async function inflateTgs(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  // Some proxies or an API change may hand out already-decoded JSON.
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("gzip decompression is unavailable");
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Static fallback for a TGS sticker: server thumbnail, then the emoji badge. */
function StickerFallback({
  thumbUrl,
  emoji,
}: {
  thumbUrl: string;
  emoji: string | null;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-24 w-24 items-center justify-center text-4xl"
      >
        {emoji ?? "✦"}
      </span>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: sticker preview is streamed by our API with a dynamic URL; next/image needs a fixed remote host.
    <img
      src={thumbUrl}
      alt={emoji ?? "Стикер"}
      loading="lazy"
      onError={() => setFailed(true)}
      className="max-h-32 max-w-32 object-contain"
    />
  );
}

/**
 * Lazy TGS player: the animation is fetched and the Lottie runtime is imported
 * only when the sticker scrolls into view, then paused while it is off-screen.
 */
function TgsSticker({
  src,
  thumbUrl,
  emoji,
}: {
  src: string;
  thumbUrl: string;
  emoji: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<AnimationItem | null>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          animationRef.current?.play();
        } else {
          animationRef.current?.pause();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || failed) return;
    const element = containerRef.current;
    if (!element) return;
    let cancelled = false;
    let animation: AnimationItem | null = null;
    const controller = new AbortController();
    const onFailure = () => {
      if (!cancelled) setFailed(true);
    };

    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const inflated = await inflateTgs(await response.arrayBuffer());
        const data: unknown = JSON.parse(new TextDecoder().decode(inflated));
        if (!data || typeof data !== "object") {
          throw new Error("tgs payload is not a Lottie animation");
        }
        const { default: lottie } = await import(
          "lottie-web/build/player/lottie_light"
        );
        if (cancelled) return;
        animation = lottie.loadAnimation({
          container: element,
          renderer: "svg",
          loop: true,
          autoplay: !document.hidden,
          // Lottie's typings expose the decoded document as `any`.
          animationData: data,
          rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
        });
        animationRef.current = animation;
        animation.addEventListener("data_failed", onFailure);
        animation.addEventListener("error", onFailure);
        setLoaded(true);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      animation?.destroy();
      animationRef.current = null;
    };
  }, [visible, failed, src]);

  return (
    <div className="relative flex h-40 w-40 items-center justify-center">
      <div
        ref={containerRef}
        aria-hidden={failed}
        className={`h-full w-full ${failed ? "hidden" : ""}`}
      />
      {!failed && !loaded && (
        <span className="absolute inset-0 flex items-center justify-center text-4xl">
          {emoji ?? <Spinner />}
        </span>
      )}
      {failed && <StickerFallback thumbUrl={thumbUrl} emoji={emoji} />}
    </div>
  );
}

/**
 * WebM sticker: muted loop with a static fallback when the media does not
 * load (offline, deleted file, blocked URL).
 */
function StickerVideo({
  src,
  poster,
  emoji,
  title,
  thumbUrl,
}: {
  src: string;
  poster: string;
  emoji: string | null;
  title: string;
  thumbUrl: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <StickerFallback thumbUrl={thumbUrl} emoji={emoji} />;
  }
  return (
    <LoopingVideo
      src={src}
      poster={poster}
      label={title}
      onError={() => setFailed(true)}
      className="h-40 w-40 rounded-lg bg-black/10 object-contain"
    />
  );
}

function mediaLabel(kind: string, emoji: string | null): string {
  if (emoji) return `${kind} ${emoji}`;
  return kind;
}

/**
 * Sticker bubble. WebP renders as an `<img>` (browsers animate it natively),
 * WebM as a muted loop and TGS through Lottie. The emoji is kept as a small
 * caption and a tooltip.
 */
export function StickerBubble({
  message,
  accountId,
  selecting,
  showAiFrames,
}: MediaBubbleProps) {
  const media = message.media;
  if (!media) return null;
  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);
  const thumbUrl = mediaUrl(accountId, message.chatId, message.id, undefined, {
    thumb: true,
  });
  const format = stickerFormat(media);
  const emoji = media.emoji ?? null;
  const title = media.stickerSet
    ? `Стикер ${media.stickerSet}`
    : mediaLabel("Стикер", emoji);

  return (
    <div className="my-1 flex flex-col items-start gap-0.5">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (selecting) event.preventDefault();
        }}
        title={title}
        className="block"
      >
        {format === "tgs" ? (
          <TgsSticker src={url} thumbUrl={thumbUrl} emoji={emoji} />
        ) : format === "webm" ? (
          <StickerVideo
            src={url}
            poster={thumbUrl}
            thumbUrl={thumbUrl}
            emoji={emoji}
            title={title}
          />
        ) : (
          // biome-ignore lint/performance/noImgElement: sticker is streamed by our API with a dynamic URL; next/image needs a fixed remote host.
          <img
            src={url}
            alt={title}
            loading="lazy"
            className="max-h-40 max-w-40 bg-transparent object-contain"
          />
        )}
      </a>
      {emoji && <span className="pl-1 text-[11px] opacity-60">{emoji}</span>}
      {showAiFrames && (
        <AiFramesRow
          accountId={accountId}
          chatId={message.chatId}
          messageId={message.id}
        />
      )}
    </div>
  );
}

/** GIF / animated-emoji bubble: MP4 or WebM loops as chromeless video. */
export function AnimationBubble({
  message,
  accountId,
  selecting,
  showAiFrames,
}: MediaBubbleProps) {
  const media = message.media;
  if (!media) return null;
  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);
  const thumbUrl = mediaUrl(accountId, message.chatId, message.id, undefined, {
    thumb: true,
  });
  const mime = (media.mimeType ?? "").toLowerCase();
  const isImage = mime === "image/gif" || mime === "image/webp";
  const title = media.emoji
    ? `Анимация ${media.emoji}`
    : media.fileName || "GIF";

  return (
    <div className="my-1 flex flex-col items-start gap-0.5">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (selecting) event.preventDefault();
        }}
        title={title}
        className="block"
      >
        {isImage ? (
          // biome-ignore lint/performance/noImgElement: animation is streamed by our API with a dynamic URL; next/image needs a fixed remote host.
          <img
            src={url}
            alt={title}
            loading="lazy"
            className="max-h-[200px] max-w-full rounded-lg object-contain"
          />
        ) : (
          <LoopingVideo
            src={url}
            poster={thumbUrl}
            label={title}
            className="max-h-[200px] max-w-full rounded-lg bg-black/10 object-contain"
          />
        )}
      </a>
      {media.emoji && (
        <span className="pl-1 text-[11px] opacity-60">{media.emoji}</span>
      )}
      {showAiFrames && (
        <AiFramesRow
          accountId={accountId}
          chatId={message.chatId}
          messageId={message.id}
        />
      )}
    </div>
  );
}

/** Round video note: tap to play, muted by default, no native chrome. */
export function VideoNoteBubble({
  message,
  accountId,
  selecting,
  showAiFrames,
}: MediaBubbleProps) {
  const media = message.media;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  if (!media) return null;
  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);
  const thumbUrl = mediaUrl(accountId, message.chatId, message.id, undefined, {
    thumb: true,
  });

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
  };

  return (
    <div className="my-1 flex flex-col items-start gap-1">
      <div className="relative h-[200px] w-[200px] overflow-hidden rounded-full bg-black/40">
        <video
          ref={videoRef}
          src={url}
          poster={thumbUrl}
          muted={muted}
          playsInline
          preload="metadata"
          aria-label="Видеосообщение"
          onClick={() => {
            if (!selecting) togglePlay();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          className="h-full w-full object-cover"
        />
        {!playing && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 text-white">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/50">
              {playGlyph("h-6 w-6 translate-x-px fill-current")}
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] opacity-75">
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={!muted}
          title={muted ? "Включить звук" : "Выключить звук"}
          className="rounded border border-white/20 bg-black/20 px-1.5 py-0.5 transition-colors hover:bg-black/30"
        >
          {muted ? "🔇" : "🔊"}
        </button>
        {media.durationSec ? (
          <span>{formatSeconds(media.durationSec)}</span>
        ) : null}
      </div>
      {showAiFrames && (
        <AiFramesRow
          accountId={accountId}
          chatId={message.chatId}
          messageId={message.id}
        />
      )}
    </div>
  );
}

/** Regular video: native controls, muted until the reader asks for sound. */
export function VideoBubble({
  message,
  accountId,
  selecting,
}: MediaBubbleProps) {
  const media = message.media;
  if (!media) return null;
  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);
  const thumbUrl = mediaUrl(accountId, message.chatId, message.id, undefined, {
    thumb: true,
  });
  return (
    <div className="my-1 flex flex-col items-start gap-1">
      {/* biome-ignore lint/a11y/useMediaCaption: captions are not available from Telegram. */}
      <video
        src={url}
        poster={thumbUrl}
        controls
        playsInline
        preload="metadata"
        onClick={(event) => {
          if (selecting) event.stopPropagation();
        }}
        className="max-h-80 max-w-full rounded-lg bg-black/30"
      />
      <span className="flex items-center gap-2 text-[11px] opacity-75">
        {media.durationSec ? (
          <span>{formatSeconds(media.durationSec)}</span>
        ) : null}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (selecting) event.preventDefault();
          }}
          className="underline underline-offset-2"
        >
          Открыть видео
        </a>
      </span>
    </div>
  );
}

/** Music/audio document. */
export function AudioBubble({ message, accountId }: MediaBubbleProps) {
  const media = message.media;
  if (!media) return null;
  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);
  return (
    <div className="my-1 flex max-w-xs flex-col gap-1">
      <span className="truncate text-xs font-medium">
        {media.fileName ?? "Аудио"}
      </span>
      {/* biome-ignore lint/a11y/useMediaCaption: captions are not available from Telegram. */}
      <audio src={url} controls preload="metadata" className="w-full" />
    </div>
  );
}

/** `1:23`-style duration for the media captions. */
function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Debug-only frame collage: the API cuts a 3x3 JPEG from the video so the AI
 * can "see" it. Never sent to Telegram; only rendered in this dashboard.
 */
export function AiFramesRow({
  accountId,
  chatId,
  messageId,
}: {
  accountId: string;
  chatId: number;
  messageId: number;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = framesUrl(accountId, chatId, messageId);
  const onToggle = useCallback((event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  }, []);
  // A reopened row retries after a transient failure.
  useEffect(() => {
    if (open) setFailed(false);
  }, [open]);

  return (
    <details
      onToggle={onToggle}
      className="mt-1 w-44 rounded-lg border border-white/15 bg-black/20 text-[11px]"
    >
      <summary className="cursor-pointer list-none px-2 py-1 opacity-70 transition-opacity hover:opacity-100">
        {open ? "▾" : "▸"} Кадры для ИИ
      </summary>
      {open && (
        <div className="space-y-1 px-2 pb-2">
          {failed ? (
            <p className="opacity-70">кадры недоступны</p>
          ) : (
            <>
              {/* biome-ignore lint/performance/noImgElement: collage is streamed by our API with a dynamic URL; next/image needs a fixed remote host. */}
              <img
                src={src}
                alt="Кадры для ИИ"
                loading="lazy"
                onError={() => setFailed(true)}
                className="w-full rounded border border-white/10"
              />
              <a
                href={src}
                download={`frames-${messageId}.jpg`}
                target="_blank"
                rel="noreferrer"
                className="block underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100"
              >
                Скачать кадры
              </a>
            </>
          )}
        </div>
      )}
    </details>
  );
}
