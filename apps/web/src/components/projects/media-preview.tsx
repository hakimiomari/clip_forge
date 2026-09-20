"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/**
 * One preview surface for both source kinds: an HTML5 <video> for
 * uploaded media, and the official YouTube player for YouTube sources
 * (whose media is never stored). Both expose the same imperative
 * handle so the timeline drives them identically.
 */

export interface PlayerHandle {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getTime(): number;
}

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    options: Record<string, unknown>,
  ) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_SCRIPT_ID = "youtube-iframe-api";

/** Loads the IFrame API once and resolves when it is usable. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    if (!document.getElementById(YT_SCRIPT_ID)) {
      const script = document.createElement("script");
      script.id = YT_SCRIPT_ID;
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
}

export const MediaPreview = forwardRef<
  PlayerHandle,
  {
    mediaUrl: string | null;
    youtubeId: string | null;
    poster?: string | null;
    onTime?: (seconds: number) => void;
    onPlayingChange?: (playing: boolean) => void;
  }
>(function MediaPreview({ mediaUrl, youtubeId, poster, onTime, onPlayingChange }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytHostRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<YTPlayer | null>(null);
  const [ytReady, setYtReady] = useState(false);
  const [ytOverlayTimedOut, setYtOverlayTimedOut] = useState(false);

  // Keep callbacks in refs so the YouTube player is created only once
  const onTimeRef = useRef(onTime);
  const onPlayingRef = useRef(onPlayingChange);
  useEffect(() => {
    onTimeRef.current = onTime;
    onPlayingRef.current = onPlayingChange;
  });

  // ── YouTube player lifecycle ─────────────────────────────
  useEffect(() => {
    if (!youtubeId || mediaUrl) return;
    let cancelled = false;
    let player: YTPlayer | null = null;

    void loadYouTubeApi().then((YT) => {
      if (cancelled || !ytHostRef.current) return;
      player = new YT.Player(ytHostRef.current, {
        videoId: youtubeId,
        playerVars: {
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            if (!cancelled) setYtReady(true);
          },
          onStateChange: (event: { data: number }) => {
            onPlayingRef.current?.(event.data === YT.PlayerState.PLAYING);
          },
        },
      });
      ytPlayerRef.current = player;
    });

    const overlayTimer = setTimeout(() => {
      if (!cancelled) setYtOverlayTimedOut(true);
    }, 4000);

    return () => {
      cancelled = true;
      clearTimeout(overlayTimer);
      ytPlayerRef.current = null;
      setYtReady(false);
      setYtOverlayTimedOut(false);
      player?.destroy();
    };
  }, [youtubeId, mediaUrl]);

  // ── Playhead ticker ──────────────────────────────────────
  // <video> only fires timeupdate ~4×/s, and the YouTube player not at
  // all, so poll on a frame loop for a playhead that tracks smoothly.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      // Re-arm first. The YouTube player throws on getCurrentTime() until
      // it is ready, and a throw after this line would kill the loop for
      // the rest of the session — freezing the playhead at 0.
      frame = requestAnimationFrame(tick);
      let time: number | undefined;
      try {
        time = videoRef.current
          ? videoRef.current.currentTime
          : ytPlayerRef.current?.getCurrentTime?.();
      } catch {
        return; // player not ready yet
      }
      if (typeof time === "number" && Number.isFinite(time)) {
        onTimeRef.current?.(time);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const seek = useCallback((seconds: number) => {
    const target = Math.max(0, seconds);
    if (videoRef.current) {
      videoRef.current.currentTime = target;
    } else {
      ytPlayerRef.current?.seekTo(target, true);
    }
    onTimeRef.current?.(target);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        if (videoRef.current) void videoRef.current.play().catch(() => undefined);
        else ytPlayerRef.current?.playVideo();
      },
      pause: () => {
        if (videoRef.current) videoRef.current.pause();
        else ytPlayerRef.current?.pauseVideo();
      },
      seek,
      getTime: () =>
        videoRef.current?.currentTime ?? ytPlayerRef.current?.getCurrentTime() ?? 0,
    }),
    [seek],
  );

  if (mediaUrl) {
    return (
      <video
        ref={videoRef}
        src={mediaUrl}
        poster={poster ?? undefined}
        playsInline
        className="h-full w-full bg-black"
        onPlay={() => onPlayingChange?.(true)}
        onPause={() => onPlayingChange?.(false)}
      />
    );
  }

  if (youtubeId) {
    return (
      <div className="relative h-full w-full bg-black">
        <div ref={ytHostRef} className="h-full w-full" />
        {/* Never let the placeholder outlive a player that did load but
            whose onReady we missed — it would sit over a usable video. */}
        {!ytReady && !ytOverlayTimedOut && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">
            Loading player…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-black text-sm text-muted">
      No preview available
    </div>
  );
});
