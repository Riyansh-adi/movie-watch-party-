"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";

type RoomInfo = {
  code: string;
  hostSocketId: string;
  usersCount: number;
};

type SyncState = {
  currentTime: number;
  isPlaying: boolean;
};

type SyncStatePayload = SyncState & {
  // Optional metadata for debugging / future improvements.
  by?: string;
  action?: "play" | "pause" | "seek" | "state";
  serverTime?: number;
};

async function safePlay(video: HTMLVideoElement) {
  try {
    await video.play();
    return true;
  } catch {
    // Autoplay can be blocked; ignore.
    return false;
  }
}

export default function RoomPage({ params }: { params: { code: string } }) {
  const router = useRouter();
  const code = params.code.trim().toUpperCase();

  const socket = useMemo(() => getSocket(), []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const applyingRemoteRef = useRef(false);
  const suppressEmitsUntilRef = useRef<number>(0);
  const isUserSeekingRef = useRef(false);
  const pendingStateRef = useRef<SyncStatePayload | null>(null);
  const desiredPlayingStateRef = useRef<SyncStatePayload | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [usersCount, setUsersCount] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);

  const isHost = !!selfId && !!hostId && selfId === hostId;

  const suppressLocalEmits = useCallback((ms: number) => {
    const until = Date.now() + ms;
    suppressEmitsUntilRef.current = Math.max(suppressEmitsUntilRef.current, until);
  }, []);

  const shouldSuppressLocalEmit = useCallback(() => {
    return applyingRemoteRef.current || Date.now() < suppressEmitsUntilRef.current;
  }, []);

  const applyRemoteState = useCallback(async (payload: SyncStatePayload) => {
    const video = videoRef.current;
    if (!video) return;

    if (video.readyState < 1) {
      pendingStateRef.current = payload;
      return;
    }

    // Don't fight the user while they're scrubbing.
    if (isUserSeekingRef.current) {
      pendingStateRef.current = payload;
      return;
    }

    const { currentTime, isPlaying } = payload;

    applyingRemoteRef.current = true;

    // Keep suppression long enough to cover delayed media events.
    suppressLocalEmits(1000);
    try {
      const diff = Math.abs(video.currentTime - currentTime);

      // Only hard-seek when the drift is noticeable.
      // While paused, be strict; while playing, allow small drift to avoid jitter.
      const threshold = isPlaying ? 0.75 : 0.15;
      if (diff > threshold) {
        try {
          video.currentTime = currentTime;
        } catch {}
      }

      if (isPlaying) {
        if (video.paused && !video.ended) {
          const ok = await safePlay(video);
          if (!ok) {
            // Autoplay blocked (common on remote-triggered play). Ask for one click.
            desiredPlayingStateRef.current = payload;
            setNeedsGesture(true);
          } else {
            setNeedsGesture(false);
          }
        }
      } else {
        if (!video.paused) video.pause();
        setNeedsGesture(false);
      }
    } finally {
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 500);
    }
  }, [suppressLocalEmits]);

  const applyPendingIfPossible = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState < 1) return;

    if (isUserSeekingRef.current) return;

    if (pendingStateRef.current) {
      const state = pendingStateRef.current;
      pendingStateRef.current = null;
      void applyRemoteState(state);
    }
  }, [applyRemoteState]);

  useEffect(() => {
    setError(null);
    setClosed(false);

    function onConnect() {
      setSelfId(socket.id ?? null);
      socket.emit("room:join", { code });
      socket.emit("sync:request", { code }, (state: SyncStatePayload) => {
        void applyRemoteState({ ...state, action: "state" });
      });
    }

    function onRoomInfo(info: RoomInfo) {
      setHostId(info.hostSocketId);
      setUsersCount(info.usersCount);
    }

    function onRoomError(payload: { message: string }) {
      setError(payload.message);
    }

    function onRoomClosed() {
      setClosed(true);
    }

    socket.on("connect", onConnect);
    socket.on("room:info", onRoomInfo);
    socket.on("room:error", onRoomError);
    socket.on("room:closed", onRoomClosed);
    socket.on("sync:state", (state: SyncStatePayload) => {
      void applyRemoteState(state);
    });

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("room:info", onRoomInfo);
      socket.off("room:error", onRoomError);
      socket.off("room:closed", onRoomClosed);
      socket.off("sync:state");
    };
  }, [applyRemoteState, code, socket]);

  useEffect(() => {
    // Light drift correction to keep both sides aligned.
    // Skip while user is scrubbing or when we don't have a loaded media element.
    const id = setInterval(() => {
      if (!socket.connected) return;
      const video = videoRef.current;
      if (!video) return;
      if (video.readyState < 1) return;
      if (isUserSeekingRef.current) return;

      socket.emit("sync:request", { code }, (state: SyncStatePayload) => {
        // Apply only if we're noticeably off.
        const diff = Math.abs(video.currentTime - state.currentTime);
        if (diff > 1.0) void applyRemoteState({ ...state, action: "state" });
      });
    }, 10000);

    return () => clearInterval(id);
  }, [applyRemoteState, code, socket]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const canControl = !closed && !error;

  // Attach native media event listeners so we can use the real DOM event's isTrusted.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = (ev: Event) => {
      if (!canControl) return;
      if (shouldSuppressLocalEmit()) return;
      if (!ev.isTrusted) return;

      socket.emit("sync:action", { code, action: "play", time: video.currentTime });
    };

    const onPause = (ev: Event) => {
      if (!canControl) return;
      if (shouldSuppressLocalEmit()) return;
      if (!ev.isTrusted) return;

      socket.emit("sync:action", { code, action: "pause", time: video.currentTime });
    };

    const onSeeking = (ev: Event) => {
      if (!ev.isTrusted) return;
      isUserSeekingRef.current = true;
    };

    const onSeeked = (ev: Event) => {
      if (!canControl) return;
      if (!ev.isTrusted) return;
      isUserSeekingRef.current = false;

      // Emit only once the seek completes.
      socket.emit("sync:action", { code, action: "seek", time: video.currentTime });
      // Apply any queued remote state after user finishes scrubbing.
      applyPendingIfPossible();
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [applyPendingIfPossible, canControl, code, shouldSuppressLocalEmit, socket]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="text-lg font-semibold">Room {code}</div>
              {isHost ? (
                <span className="rounded-full bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white">
                  Host
                </span>
              ) : (
                <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                  Guest
                </span>
              )}
              <span className="text-sm text-zinc-600">Users: {usersCount}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(code);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  } catch {}
                }}
              >
                {copied ? "Copied" : "Copy code"}
              </button>
              <button
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50"
                onClick={() => router.push("/")}
              >
                Leave
              </button>
            </div>
          </div>

          {(error || closed) && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
              {closed ? "Room closed (host disconnected)." : `Error: ${error ?? "Unknown error"}`}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="relative rounded-2xl border border-zinc-200 bg-black/95">
              <video
                ref={videoRef}
                className="aspect-video w-full rounded-2xl"
                src={videoUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={() => applyPendingIfPossible()}
                onError={() => {
                  setFormatNote(
                    "This format may not be supported by your browser. Try MP4 (H.264/AAC) or WebM if playback fails."
                  );
                }}
              />

              {needsGesture && (
                <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/60 p-4">
                  <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-950/80 p-4 text-center text-white">
                    <div className="text-sm font-semibold">Playback needs one click</div>
                    <div className="mt-2 text-xs text-zinc-200">
                      Your browser blocked autoplay. Click below once to resume synced playback.
                    </div>
                    <button
                      className="mt-3 w-full rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
                      onClick={async () => {
                        const video = videoRef.current;
                        const desired = desiredPlayingStateRef.current;
                        if (!video || !desired) return;

                        // Seek first, then try play in the user gesture.
                        try {
                          video.currentTime = desired.currentTime;
                        } catch {}

                        const ok = await safePlay(video);
                        if (ok) {
                          setNeedsGesture(false);
                          desiredPlayingStateRef.current = null;
                        }
                      }}
                    >
                      Start playback
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="text-sm font-semibold text-zinc-900">Local video</div>
              <div className="text-sm text-zinc-600">
                Both people must pick the same file from their own computer. The file is never uploaded.
              </div>

              <label className="block">
                <span className="sr-only">Choose video</span>
                <input
                  type="file"
                  accept="video/*,audio/*,.mkv,.mp4,.webm,.mov,.m4v,.avi,.mp3,.m4a,.wav,.ogg"
                  className="block w-full cursor-pointer rounded-xl border border-zinc-200 bg-white p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:bg-zinc-50"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;

                    setSelectedFileName(file.name);
                    setFormatNote(null);

                    if (videoUrl) URL.revokeObjectURL(videoUrl);
                    const url = URL.createObjectURL(file);
                    setVideoUrl(url);

                    const video = videoRef.current;
                    if (video) {
                      const mime = file.type;
                      if (mime) {
                        const can = video.canPlayType(mime);
                        if (!can) {
                          setFormatNote(
                            `Your browser may not support this media type (${mime}). If playback fails, try MP4 (H.264/AAC) or WebM.`
                          );
                        }
                      }
                    }

                    setTimeout(() => applyPendingIfPossible(), 0);
                  }}
                />
              </label>

              {selectedFileName && (
                <div className="text-xs text-zinc-600">Selected: {selectedFileName}</div>
              )}

              {formatNote && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
                  {formatNote}
                </div>
              )}

              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                Everyone can control playback. Any play/pause/seek will sync to the whole room.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
